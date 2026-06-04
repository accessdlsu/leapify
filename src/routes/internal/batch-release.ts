import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { LeapifyEnv } from "../../types";
import { batchRelease } from "../../cron/batch-release";
import { internalMiddleware } from "../../auth/middleware";

export const batchReleaseRoute = new Hono<LeapifyEnv>();

batchReleaseRoute.post(
  "/",
  describeRoute({
    tags: ["Internal"],
    summary: "Batch release queued events",
    description: "Triggers batch release of queued events whose releaseAt time has passed.",
    responses: { 200: { description: "Batch release complete" } },
  }),
  internalMiddleware,
  async (c) => {
  await batchRelease(c.env);
  return c.json({ ok: true });
});
