import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { eq } from "drizzle-orm";
import type { LeapifyEnv } from "../../types";
import { createDb } from "../../db";
import { events } from "../../db/schema/classes";
import { SlotsService } from "../../services/slots";
import { GFormsService } from "../../services/gforms";
import { RegistrationsService } from "../../services/registrations";
import { internalMiddleware } from "../../auth/middleware";

export const gformsWebhookRoute = new Hono<LeapifyEnv>();

/**
 * POST /internal/gforms-webhook
 *
 * Receives Google Forms Watch push notifications.
 * Each notification means one student submitted the form.
 * We increment the local D1 counter and fetch+upsert respondent emails
 * into the registrations table for near-instant "has registered" checks.
 *
 * Security:
 *   1. X-Internal-Secret header (internalMiddleware) — prevents external access
 *   2. X-Goog-Signature HMAC  — verifies payload is genuinely from Google
 */
gformsWebhookRoute.post(
  "/",
  describeRoute({
    tags: ["Internal"],
    summary: "Google Forms webhook receiver",
    description: "Receives Google Forms Watch push notifications, increments slot counters, and syncs registrations.",
    responses: {
      200: { description: "Notification processed" },
      400: { description: "Invalid payload" },
      403: { description: "Invalid HMAC signature" },
    },
  }),
  internalMiddleware,
  async (c) => {
  const rawBody = await c.req.text();

  // Verify Google HMAC signature
  const signature = c.req.header("X-Goog-Signature");
  if (signature) {
    const isValid = await verifyGoogSignature(
      rawBody,
      signature,
      c.env.GFORMS_WEBHOOK_SECRET,
    );
    if (!isValid) {
      return c.json({ error: "Invalid signature" }, 403);
    }
  }

  let payload: { formId?: string; watchId?: string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid payload" }, 400);
  }

  const { formId } = payload;
  if (!formId) return c.json({ error: "Missing formId" }, 400);

  const db = createDb(c.env.DB);

  const event = await db.query.events.findFirst({
    where: eq(events.gformsId, formId),
    columns: { id: true, slug: true, maxSlots: true, registeredSlots: true },
  });

  if (!event) {
    console.warn(`[gforms-webhook] Unknown formId: ${formId}`);
    return c.json({ ok: true });
  }

  // Increment slot counter
  const slotsService = new SlotsService(db);
  const updated = await slotsService.increment(event.slug);
  console.log(
    `[gforms-webhook] Incremented "${event.slug}": ${updated?.registered}/${updated?.total}`,
  );

  // Fetch all respondents and upsert into registrations table (near-instant registration tracking)
  try {
    const gforms = new GFormsService(c.env.GFORMS_SERVICE_ACCOUNT_JSON);
    const responses = await gforms.getAllResponses(formId);
    const respondents = responses
      .filter((r) => r.respondentEmail)
      .map((r) => ({
        email: r.respondentEmail!,
        submittedAt: Math.floor(new Date(r.createTime).getTime() / 1000),
      }));

    const regsService = new RegistrationsService(db);
    await regsService.upsertRespondents(event.id, respondents);
    console.log(
      `[gforms-webhook] Upserted ${respondents.length} registrations for "${event.slug}"`,
    );
  } catch (err) {
    // Don't fail the webhook if registration sync fails — slot count already updated
    console.error(`[gforms-webhook] Registration sync failed for "${event.slug}":`, err);
  }

  return c.json({ ok: true });
});

// HMAC verification

async function verifyGoogSignature(
  body: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const sigHex = signature.replace(/^hmac-sha256=/, "");
    const sigBytes = Uint8Array.from(
      sigHex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? [],
    );

    return crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(body),
    );
  } catch {
    return false;
  }
}
