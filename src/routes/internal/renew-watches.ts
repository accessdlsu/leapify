import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { LeapifyEnv } from "../../types";
import { renewWatches } from "../../cron/renew-watches";
import { internalMiddleware } from "../../auth/middleware";

export const renewWatchesRoute = new Hono<LeapifyEnv>();

renewWatchesRoute.post(
  "/",
  describeRoute({
    tags: ["Internal"],
    summary: "Renew Google Forms watches",
    description: "Triggers renewal of expiring Google Forms Watch subscriptions.",
    responses: { 200: { description: "Watch renewal complete" } },
  }),
  internalMiddleware,
  async (c) => {
  await renewWatches(c.env);
  return c.json({ ok: true });
});
