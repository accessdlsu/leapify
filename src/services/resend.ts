/**
 * Resend transactional email client.
 * Fully fetch-native — no SDK, fully edge-compatible.
 */

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  from?: string; // defaults to LeapifyConfig.resend.fromAddress
  replyTo?: string;
}

export interface BatchEmailOptions {
  emails: SendEmailOptions[];
}

export class ResendService {
  private readonly apiKey: string;
  private readonly defaultFrom: string;

  constructor(apiKey: string, fromAddress: string) {
    this.apiKey = apiKey;
    this.defaultFrom = fromAddress;
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async sendEmail(options: SendEmailOptions): Promise<{ id: string }> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        from: options.from ?? this.defaultFrom,
        to: Array.isArray(options.to) ? options.to : [options.to],
        subject: options.subject,
        html: options.html,
        ...(options.replyTo ? { reply_to: options.replyTo } : {}),
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Resend API error ${response.status}: ${err}`);
    }

    return response.json() as Promise<{ id: string }>;
  }

  async sendBatch(emails: SendEmailOptions[]): Promise<{ id: string }[]> {
    const response = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(
        emails.map((e) => ({
          from: e.from ?? this.defaultFrom,
          to: Array.isArray(e.to) ? e.to : [e.to],
          subject: e.subject,
          html: e.html,
          ...(e.replyTo ? { reply_to: e.replyTo } : {}),
        })),
      ),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Resend batch API error ${response.status}: ${err}`);
    }

    const data = (await response.json()) as { data: { id: string }[] };
    return data.data;
  }
}

// Email templates

export function buildReminderEmail(event: {
  title: string;
  organization?: string | null;
  dateTime?: string | null;
  startTime?: string | null;
  venue?: string | null;
  gformsUrl?: string | null;
}): string {
  const timeDisplay = [event.dateTime, event.startTime].filter(Boolean).join(" at ");
  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a2e;">📅 Reminder: ${event.title}</h2>
      ${event.organization ? `<p style="color: #666;">Organized by: <strong>${event.organization}</strong></p>` : ""}
      ${timeDisplay ? `<p>🕐 <strong>${timeDisplay}</strong></p>` : ""}
      ${event.venue ? `<p>📍 <strong>${event.venue}</strong></p>` : ""}
      <hr style="margin: 24px 0; border: none; border-top: 1px solid #eee;" />
      ${
        event.gformsUrl
          ? `<p>You registered for this event. See you there!</p>
             <a href="${event.gformsUrl}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;">View Registration</a>`
          : "<p>You registered for this event. See you there!</p>"
      }
      <p style="margin-top: 32px; font-size: 12px; color: #999;">
        DLSU CSO LEAP — This is an automated reminder.
      </p>
    </div>
  `;
}
