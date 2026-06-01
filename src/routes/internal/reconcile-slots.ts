import { Hono } from "hono";
import type { LeapifyEnv } from "../../types";
import { reconcileSlots } from "../../cron/reconcile-slots";
import { internalMiddleware } from "../../auth/middleware";

export const reconcileSlotsRoute = new Hono<LeapifyEnv>();

reconcileSlotsRoute.post("/", internalMiddleware, async (c) => {
  await reconcileSlots(c.env);
  return c.json({ ok: true });
});
