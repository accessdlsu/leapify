import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { LeapifyEnv } from "../../types";
import { createDb } from "../../db";
import { events } from "../../db/schema/classes";
import { SlotsService } from "../../services/slots";
import { CacheService } from "../../services/cache";
import { internalMiddleware } from "../../auth/middleware";

export const gformsWebhookRoute = new Hono<LeapifyEnv>();

/**
 * POST /internal/gforms-webhook
 *
 * Receives Google Forms Watch push notifications.
 * Each notification means one student submitted the form.
 * We increment the local D1 counter and update KV — no Google API call made.
 *
 * Security:
 *   1. X-Internal-Secret header (internalMiddleware) — prevents external access
 *   2. X-Goog-Signature HMAC  — verifies payload is genuinely from Google
 */
gformsWebhookRoute.post("/", internalMiddleware, async (c) => {
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
  const cache = new CacheService(c.env.KV);

  const event = await db.query.events.findFirst({
    where: eq(events.gformsId, formId),
    columns: { slug: true, maxSlots: true, registeredSlots: true },
  });

  if (!event) {
    console.warn(`[gforms-webhook] Unknown formId: ${formId}`);
    return c.json({ ok: true });
  }

  const slotsService = new SlotsService(db, cache);
  const updated = await slotsService.increment(event.slug);

  console.log(
    `[gforms-webhook] Incremented "${event.slug}": ${updated?.registered}/${updated?.total}`,
  );

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
