import { Collection } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import type pg from "pg";

// ── Types ──────────────────────────────────────────────────────────────────

export interface AuthSession {
  token: string;
  userId: string;
  email: string;
  name: string;
  picture: string;
  createdAt: Date;
}

export interface UserPublic {
  userId: string;
  email: string;
  name: string;
  picture: string;
}

interface GoogleUserProfile {
  email: string;
  name: string;
  picture: string;
  accessToken: string;
  token: string; // Google ID token
}

// ── Collection (set from db.ts) ────────────────────────────────────────────

let authSessions: Collection<AuthSession>;

export function initAuthSessionsCollection(
  collection: Collection<AuthSession>
): void {
  authSessions = collection;
}

// ── PG pool (set from index.ts) ────────────────────────────────────────────

let pgPool: pg.Pool;

export function initPgPool(pool: pg.Pool): void {
  pgPool = pool;
}

// ── Google auth ────────────────────────────────────────────────────────────

/**
 * Authenticate a user via Google OAuth profile from auth.lohono.com.
 *
 * 1. Decode the base64 userProfile payload
 * 2. Verify the email exists in the PostgreSQL `staffs` table and is active
 * 3. Upsert a non-expiring session in MongoDB
 */
export async function authenticateGoogleUser(
  base64Profile: string
): Promise<{ token: string; user: UserPublic }> {
  // 1. Decode profile
  let profile: GoogleUserProfile;
  try {
    const json = Buffer.from(base64Profile, "base64").toString("utf-8");
    profile = JSON.parse(json);
  } catch {
    throw new Error("Invalid userProfile payload");
  }

  if (!profile.email) {
    throw new Error("Email missing from Google profile");
  }

  const email = profile.email.toLowerCase().trim();

  // 2. Verify staff in PostgreSQL
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const result = await client.query(
      `SELECT email, active FROM public.staffs WHERE LOWER(email) = $1 LIMIT 1`,
      [email]
    );
    await client.query("COMMIT");

    if (result.rows.length === 0) {
      throw new Error("Access denied: email not found in staff directory");
    }

    const row = result.rows[0] as { email: string; active: boolean };
    if (!row.active) {
      throw new Error("Access denied: staff account is deactivated");
    }
  } catch (error) {
    // Re-throw auth errors as-is, wrap DB errors
    if (error instanceof Error && error.message.startsWith("Access denied")) {
      throw error;
    }
    await client.query("ROLLBACK").catch(() => {});
    throw new Error("Failed to verify staff access");
  } finally {
    client.release();
  }

  // 3. Upsert auth session in MongoDB (reuse existing session if user already has one)
  const existing = await authSessions.findOne({ email });
  if (existing) {
    // Update profile info but keep the same token
    await authSessions.updateOne(
      { email },
      {
        $set: {
          name: profile.name || existing.name,
          picture: profile.picture || existing.picture,
        },
      }
    );
    return {
      token: existing.token,
      user: {
        userId: existing.userId,
        email: existing.email,
        name: profile.name || existing.name,
        picture: profile.picture || existing.picture,
      },
    };
  }

  // Create new session (no expiry)
  const session: AuthSession = {
    token: uuidv4(),
    userId: email, // use email as userId
    email,
    name: profile.name || "",
    picture: profile.picture || "",
    createdAt: new Date(),
  };

  await authSessions.insertOne(session);

  return {
    token: session.token,
    user: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      picture: session.picture,
    },
  };
}

// ── Session validation ─────────────────────────────────────────────────────

export async function validateSession(
  token: string
): Promise<UserPublic | null> {
  const session = await authSessions.findOne({ token });
  if (!session) return null;
  return {
    userId: session.userId,
    email: session.email,
    name: session.name,
    picture: session.picture,
  };
}

// ── Logout ─────────────────────────────────────────────────────────────────

export async function deleteSessionByToken(token: string): Promise<void> {
  await authSessions.deleteOne({ token });
}
