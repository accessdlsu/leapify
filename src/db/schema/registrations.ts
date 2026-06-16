import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { events } from "./classes";

export const registrations = sqliteTable(
  "registrations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID().replace(/-/g, "")),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    submittedAt: integer("submitted_at").notNull(), // epoch from Google Forms createTime
  },
  (table) => ({
    // One registration per student per event
    eventEmailIdx: uniqueIndex("idx_registrations_event_email").on(
      table.eventId,
      table.email,
    ),
    // Fast lookup by email (for GET /users/me/registration)
    emailIdx: index("idx_registrations_email").on(table.email),
  }),
);

export const registrationsRelations = relations(registrations, ({ one }) => ({
  event: one(events, {
    fields: [registrations.eventId],
    references: [events.id],
  }),
}));

export type Registration = typeof registrations.$inferSelect;
export type NewRegistration = typeof registrations.$inferInsert;
