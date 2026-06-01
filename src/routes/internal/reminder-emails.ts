import { Hono } from "hono";
import type { LeapifyEnv } from "../../types";
import { reminderEmails } from "../../cron/reminder-emails";
import { internalMiddleware } from "../../auth/middleware";

export const reminderEmailsRoute = new Hono<LeapifyEnv>();

reminderEmailsRoute.post("/", internalMiddleware, async (c) => {
  await reminderEmails(c.env);
  return c.json({ ok: true });
});
