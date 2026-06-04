import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { LeapifyEnv } from "../../types";
import { reminderEmails } from "../../cron/reminder-emails";
import { internalMiddleware } from "../../auth/middleware";

export const reminderEmailsRoute = new Hono<LeapifyEnv>();

reminderEmailsRoute.post(
  "/",
  describeRoute({
    tags: ["Internal"],
    summary: "Send reminder emails",
    description: "Triggers reminder email processing for upcoming events.",
    responses: { 200: { description: "Reminder emails processed" } },
  }),
  internalMiddleware,
  async (c) => {
  await reminderEmails(c.env);
  return c.json({ ok: true });
});
