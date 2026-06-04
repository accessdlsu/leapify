import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { LeapifyEnv } from "../../types";
import { reconcileSlots } from "../../cron/reconcile-slots";
import { internalMiddleware } from "../../auth/middleware";

export const reconcileSlotsRoute = new Hono<LeapifyEnv>();

reconcileSlotsRoute.post(
  "/",
  describeRoute({
    tags: ["Internal"],
    summary: "Reconcile event slot counts",
    description: "Triggers slot count reconciliation for all events with Google Forms.",
    responses: { 200: { description: "Reconciliation complete" } },
  }),
  internalMiddleware,
  async (c) => {
  await reconcileSlots(c.env);
  return c.json({ ok: true });
});
