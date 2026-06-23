/**
 * Google Forms API client using service account OAuth2.
 * Fully fetch-native — no googleapis SDK (not edge compatible).
 */

interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface FormResponse {
  responseId: string;
  createTime: string;
  lastSubmittedTime: string;
  respondentEmail?: string;
  answers?: Record<string, unknown>;
}

interface ListResponsesResult {
  responses: FormResponse[];
  nextPageToken?: string;
}

export class GFormsService {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private readonly credentials: ServiceAccountCredentials;

  constructor(serviceAccountJson: string) {
    this.credentials = JSON.parse(
      serviceAccountJson,
    ) as ServiceAccountCredentials;
  }

  // OAuth2 token management

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const token = await this.fetchServiceAccountToken();
    this.accessToken = token.access_token;
    this.tokenExpiresAt = Date.now() + (token.expires_in - 60) * 1000; // 1min buffer
    return this.accessToken;
  }

  private async fetchServiceAccountToken(): Promise<TokenResponse> {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: this.credentials.client_email,
      scope: "https://www.googleapis.com/auth/forms.responses.readonly https://www.googleapis.com/auth/forms.body",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    };

    const jwt = await this.createJwt(claims);

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to get service account token: ${err}`);
    }

    return response.json() as Promise<TokenResponse>;
  }

  private async createJwt(claims: Record<string, unknown>): Promise<string> {
    const header = { alg: "RS256", typ: "JWT" };

    const encode = (obj: unknown) =>
      btoa(JSON.stringify(obj))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");

    const headerB64 = encode(header);
    const payloadB64 = encode(claims);
    const signingInput = `${headerB64}.${payloadB64}`;

    // Import private key from PEM
    const pemBody = this.credentials.private_key
      .replace(/-----BEGIN PRIVATE KEY-----/, "")
      .replace(/-----END PRIVATE KEY-----/, "")
      .replace(/\s/g, "");

    const keyBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      keyBytes,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      new TextEncoder().encode(signingInput),
    );

    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    return `${signingInput}.${sigB64}`;
  }

  // Forms API

  /**
   * Get the total response count for a form.
   * Used by reconciliation cron — not called at runtime per-user.
   */
  async getResponseCount(formId: string): Promise<number> {
    return this.getExactResponseCount(formId);
  }

  /**
   * List all form responses including respondent emails.
   * Used by reminder email cron — 1 call per event per reminder cycle.
   */
  async getAllResponses(formId: string): Promise<FormResponse[]> {
    const token = await this.getAccessToken();
    const allResponses: FormResponse[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(
        `https://forms.googleapis.com/v1/forms/${formId}/responses`,
      );
      url.searchParams.set("pageSize", "500");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Forms API error: ${response.status} ${err}`);
      }

      const data = (await response.json()) as ListResponsesResult;
      allResponses.push(...(data.responses ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);

    return allResponses;
  }

  /**
   * Get respondent email addresses for a form.
   * Google Forms automatically collects emails when "Collect email addresses" is enabled.
   */
  async getRespondentEmails(formId: string): Promise<string[]> {
    const responses = await this.getAllResponses(formId);
    return responses
      .map((r) => r.respondentEmail)
      .filter((email): email is string => Boolean(email));
  }

  /**
   * Get the total response count more accurately by fetching all responses.
   * Used for precise reconciliation.
   */
  async getExactResponseCount(formId: string): Promise<number> {
    const responses = await this.getAllResponses(formId);
    return responses.length;
  }

  // Watch management

  /**
   * Create a Watch on a Google Form.
   * Fires a push notification to webhookUrl on every new response.
   *
   * @param formId  - Google Form ID
   * @param webhookUrl - Full HTTPS URL Google will POST to on new submissions
   *                     (e.g. https://leap.yourdomain.com/internal/gforms-webhook)
   */
  async createWatch(
    formId: string,
    webhookUrl: string,
  ): Promise<{ watchId: string; expireTime: string }> {
    const token = await this.getAccessToken();

    const response = await fetch(
      `https://forms.googleapis.com/v1/forms/${formId}/watches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          watch: {
            target: {
              // HTTP push: Google POSTs the notification directly to our worker.
              // The URL must be HTTPS and publicly reachable.
              httpTarget: { uri: webhookUrl },
            },
            eventType: "RESPONSES",
          },
        }),
      },
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to create Watch: ${err}`);
    }

    const data = (await response.json()) as { id: string; expireTime: string };
    return { watchId: data.id, expireTime: data.expireTime };
  }

  /**
   * Open or close a Google Form to new responses.
   * Called when registrationEnabled is toggled or when a class fills up.
   */
  async setAcceptingResponses(formId: string, isAccepting: boolean): Promise<void> {
    const token = await this.getAccessToken()

    const response = await fetch(
      `https://forms.googleapis.com/v1/forms/${formId}:setPublishSettings`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          publishSettings: {
            publishState: { isPublished: true, isAcceptingResponses: isAccepting },
          },
        }),
      },
    )

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Failed to set form accepting responses: ${err}`)
    }
  }

  /**
   * Renew an existing Watch (reset its 7-day TTL).
   */
  async renewWatch(
    formId: string,
    watchId: string,
  ): Promise<{ expireTime: string }> {
    const token = await this.getAccessToken();

    const response = await fetch(
      `https://forms.googleapis.com/v1/forms/${formId}/watches/${watchId}:renew`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to renew Watch ${watchId}: ${err}`);
    }

    const data = (await response.json()) as { expireTime: string };
    return { expireTime: data.expireTime };
  }
}
