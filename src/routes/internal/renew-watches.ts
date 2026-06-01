import { Hono } from "hono";
import type { LeapifyEnv } from "../../types";
import { renewWatches } from "../../cron/renew-watches";
import { internalMiddleware } from "../../auth/middleware";

export const renewWatchesRoute = new Hono<LeapifyEnv>();

renewWatchesRoute.post("/", internalMiddleware, async (c) => {
  await renewWatches(c.env);
  return c.json({ ok: true });
});
