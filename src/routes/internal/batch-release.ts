import { Hono } from "hono";
import type { LeapifyEnv } from "../../types";
import { batchRelease } from "../../cron/batch-release";
import { internalMiddleware } from "../../auth/middleware";

export const batchReleaseRoute = new Hono<LeapifyEnv>();

batchReleaseRoute.post("/", internalMiddleware, async (c) => {
  await batchRelease(c.env);
  return c.json({ ok: true });
});
