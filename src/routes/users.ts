import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { eq, and } from "drizzle-orm";
import type { LeapifyEnv } from "../types";
import { createDb } from "../db";
import { users, type UserRole } from "../db/schema/users";
import { authUser } from "../db/schema/auth";
import { bookmarks } from "../db/schema/bookmarks";
import { events } from "../db/schema/classes";
import { authMiddleware, adminMiddleware, optionalAuthMiddleware } from "../auth/middleware";
import { notFound, badRequest } from "../lib/errors";
import { bookmarksRateLimit } from "../lib/middleware/rate-limit";

const VALID_ROLES: UserRole[] = ["student", "admin", "super_admin"];

export const usersRoute = new Hono<LeapifyEnv>();

// ─── Admin: User Management ─────────────────────────────────────────────────

// GET /users — admin only, list all users
usersRoute.get(
  "/",
  describeRoute({
    tags: ["Users"],
    summary: "List all users (admin)",
    responses: { 200: { description: "List of users" } },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
  const db = createDb(c.env.DB);
  const data = await db.select().from(users);
  return c.json({ data });
});

// PATCH /users/:id/role — admin only, change user role
usersRoute.patch(
  "/:id/role",
  describeRoute({
    tags: ["Users"],
    summary: "Change user role (admin)",
    responses: {
      200: { description: "Role updated" },
      400: { description: "Invalid role" },
      404: { description: "User not found" },
    },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
  const { id } = c.req.param();
  const { role } = await c.req.json<{ role: string }>();

  if (!role || !VALID_ROLES.includes(role as UserRole)) {
    throw badRequest("Role must be 'student', 'admin', or 'super_admin'.");
  }

  const db = createDb(c.env.DB);
  const [updated] = await db
    .update(users)
    .set({ role: role as UserRole })
    .where(eq(users.id, id))
    .returning();

  if (!updated) throw notFound("User");

  return c.json({ data: updated });
});

// POST /users/by-email — admin only, find or create user by email and set role
usersRoute.post(
  "/by-email",
  describeRoute({
    tags: ["Users"],
    summary: "Find or create user by email (admin)",
    responses: {
      200: { description: "User updated" },
      201: { description: "User created" },
      400: { description: "Invalid email or role" },
    },
  }),
  authMiddleware,
  adminMiddleware,
  async (c) => {
  const { email, role } = await c.req.json<{ email: string; role: string }>();

  if (!email || !role || !VALID_ROLES.includes(role as UserRole)) {
    throw badRequest("Email and valid role ('student', 'admin', 'super_admin') are required.");
  }

  const db = createDb(c.env.DB);

  // Find existing user by email
  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (existing) {
    // Update role
    const [updated] = await db
      .update(users)
      .set({ role: role as UserRole })
      .where(eq(users.email, email))
      .returning();
    return c.json({ data: updated });
  }

  // Create a placeholder user (they'll get a real betterAuthId on first login)
  const [created] = await db
    .insert(users)
    .values({ betterAuthId: `pending:${email}`, email, name: email.split("@")[0], role: role as UserRole })
    .returning();

  return c.json({ data: created }, 201);
});

// ─── Public / Auth: User Profile ─────────────────────────────────────────────

// GET /users/me
usersRoute.get(
  "/me",
  describeRoute({
    tags: ["Users"],
    summary: "Get current user profile",
    responses: { 200: { description: "Current user profile or null" } },
  }),
  optionalAuthMiddleware,
  async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ data: null });

  const db = createDb(c.env.DB);
  const profile = await db.query.users.findFirst({
    where: eq(users.id, user.dbId),
  });

  if (!profile) return c.json({ data: null });

  // Join with authUser to get the Google profile image
  const auth = await db.query.authUser.findFirst({
    where: eq(authUser.id, profile.betterAuthId),
    columns: { image: true },
  });

  return c.json({ data: { ...profile, image: auth?.image ?? null } });
});

// GET /users/me/bookmarks
usersRoute.get(
  "/me/bookmarks",
  describeRoute({
    tags: ["Users"],
    summary: "Get current user's bookmarks",
    responses: { 200: { description: "List of bookmarked events" } },
  }),
  optionalAuthMiddleware,
  async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ data: [] });

  const db = createDb(c.env.DB);
  const rows = await db.query.bookmarks.findMany({
    where: eq(bookmarks.userId, user.dbId),
    with: { event: true },
  });

  const data = rows.map((r) => ({ bookmarkedAt: r.createdAt, event: r.event }));
  return c.json({ data });
});

// POST /users/me/bookmarks/:eventId — toggle
usersRoute.post(
  "/me/bookmarks/:eventId",
  describeRoute({
    tags: ["Users"],
    summary: "Toggle bookmark for an event",
    responses: {
      201: { description: "Bookmark created" },
      200: { description: "Bookmark removed" },
      404: { description: "Event not found" },
    },
  }),
  authMiddleware,
  bookmarksRateLimit,
  async (c) => {
  const { eventId } = c.req.param();
  const user = c.get("user");
  const db = createDb(c.env.DB);

  // Verify event exists
  const event = await db.query.events.findFirst({
    where: eq(events.id, eventId),
    columns: { id: true },
  });
  if (!event) throw notFound("Event");

  // Try an atomic insert that silently skips if the unique constraint is hit.
  const inserted = await db
    .insert(bookmarks)
    .values({ userId: user.dbId, eventId })
    .onConflictDoNothing({ target: [bookmarks.userId, bookmarks.eventId] })
    .returning();

  if (inserted.length > 0) {
    return c.json({ data: { bookmarked: true } }, 201);
  }

  await db
    .delete(bookmarks)
    .where(and(eq(bookmarks.userId, user.dbId), eq(bookmarks.eventId, eventId)));

  return c.json({ data: { bookmarked: false } }, 200);
});

// DELETE /users/me/bookmarks/:eventId
usersRoute.delete(
  "/me/bookmarks/:eventId",
  describeRoute({
    tags: ["Users"],
    summary: "Remove bookmark for an event",
    responses: { 200: { description: "Bookmark removed" } },
  }),
  authMiddleware,
  async (c) => {
  const { eventId } = c.req.param();
  const user = c.get("user");
  const db = createDb(c.env.DB);

  await db
    .delete(bookmarks)
    .where(
      and(eq(bookmarks.userId, user.dbId), eq(bookmarks.eventId, eventId)),
    );

  return c.json({ data: { bookmarked: false } });
});
