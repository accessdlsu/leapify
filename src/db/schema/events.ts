import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql, relations } from "drizzle-orm";
import { themes } from "./themes";

export const events = sqliteTable(
  "events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID().replace(/-/g, "")),
    slug: text("slug").notNull().unique(),
    // Theme reference
    themeId: text("theme_id").references(() => themes.id),

    // Core event fields (maps to LinkData)
    title: text("title").notNull(),
    org: text("org"), // organizing body / college
    venue: text("venue"),
    dateTime: text("date_time"), // human-readable display string
    startsAt: integer("starts_at"), // unix epoch (machine use)
    endsAt: integer("ends_at"),
    price: text("price"), // e.g. "Free" or "₱150"
    backgroundColor: text("background_color"),
    backgroundImageUrl: text("background_image_url"),

    // Extended classification
    subtheme: text("subtheme"), // freeform, e.g. "Leadership"
    isMajor: integer("is_major", { mode: "boolean" }).notNull().default(false),

    // Slot tracking (local counter — NOT polled from Google Forms)
    maxSlots: integer("max_slots").notNull().default(0),
    registeredSlots: integer("registered_slots").notNull().default(0),
    gformsId: text("gforms_id"), // Google Form ID for Watch + reconciliation
    gformsUrl: text("gforms_url"), // informational link shown to students
    watchId: text("watch_id"), // stored after forms.watches.create
    watchExpiresAt: integer("watch_expires_at"), // epoch — for renewal cron

    // Lifecycle / Release Queue
    status: text("status", {
      enum: ["draft", "queued", "published", "ended", "cancelled"],
    })
      .notNull()
      .default("draft"),
    releaseAt: integer("release_at"), // scheduled publish epoch
    registrationOpensAt: integer("registration_opens_at"),
    registrationClosesAt: integer("registration_closes_at"),

    // Reminder tracking
    reminder24hSent: integer("reminder_24h_sent", { mode: "boolean" })
      .notNull()
      .default(false),
    reminder1hSent: integer("reminder_1h_sent", { mode: "boolean" })
      .notNull()
      .default(false),

    // CMS
    contentfulEntryId: text("contentful_entry_id"),

    // Audit
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    publishedAt: integer("published_at"),
  },
  (table) => ({
    statusReleaseIdx: index("idx_events_status_release").on(
      table.status,
      table.releaseAt,
    ),
    themeIdx: index("idx_events_theme_id").on(table.themeId),
    slugIdx: index("idx_events_slug").on(table.slug),
  }),
);

export const eventsRelations = relations(events, ({ one }) => ({
  theme: one(themes, {
    fields: [events.themeId],
    references: [themes.id],
  }),
}));

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type EventStatus =
  | "draft"
  | "queued"
  | "published"
  | "ended"
  | "cancelled";
