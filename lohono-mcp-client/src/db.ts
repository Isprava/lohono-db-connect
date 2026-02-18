import { MongoClient, Db, Collection, ObjectId } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import { initAuthSessionsCollection, type AuthSession } from "./auth.js";
import { Vertical, DEFAULT_VERTICAL } from "../../shared/types/verticals.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface Session {
  sessionId: string;
  userId: string;
  title: string;
  vertical: Vertical;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  sessionId: string;
  role: "user" | "assistant" | "tool_use" | "tool_result";
  content: string;
  /** For role=tool_use: the tool name */
  toolName?: string;
  /** For role=tool_use: the tool input arguments */
  toolInput?: Record<string, unknown>;
  /** For role=tool_use / tool_result: the tool_use id from Claude */
  toolUseId?: string;
  createdAt: Date;
}

// ── ACL Config Types ──────────────────────────────────────────────────────

export interface AclToolConfig {
  toolName: string;
  acls: string[];
  updatedAt: Date;
  updatedBy: string;
}

export interface AclGlobalConfig {
  default_policy: "open" | "deny";
  public_tools: string[];
  disabled_tools: string[];
  updatedAt: Date;
  updatedBy: string;
}

// ── Singleton ──────────────────────────────────────────────────────────────

let client: MongoClient;
let db: Db;
let sessions: Collection<Session>;
let messages: Collection<Message>;
let aclConfigs: Collection<AclToolConfig>;
let aclGlobalConfig: Collection<AclGlobalConfig>;

export async function connectDB(): Promise<Db> {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
  const dbName = process.env.MONGODB_DB_NAME || "mcp_client";

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);

  sessions = db.collection<Session>("sessions");
  messages = db.collection<Message>("messages");
  aclConfigs = db.collection<AclToolConfig>("acl_configs");
  aclGlobalConfig = db.collection<AclGlobalConfig>("acl_global_config");
  const authSessionsColl = db.collection<AuthSession>("auth_sessions");

  // Initialize auth sessions collection
  initAuthSessionsCollection(authSessionsColl);

  // Indexes
  await sessions.createIndex({ sessionId: 1 }, { unique: true });
  await sessions.createIndex({ userId: 1, updatedAt: -1 });
  await messages.createIndex({ sessionId: 1, createdAt: 1 });
  await aclConfigs.createIndex({ toolName: 1 }, { unique: true });
  await authSessionsColl.createIndex({ token: 1 }, { unique: true });
  await authSessionsColl.createIndex({ email: 1 }, { unique: true });
  // TTL index: MongoDB auto-deletes documents when expiresAt is in the past
  await authSessionsColl.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  console.log(`MongoDB connected: ${uri}/${dbName}`);
  return db;
}

export async function disconnectDB(): Promise<void> {
  if (client) await client.close();
}

// ── Session CRUD ───────────────────────────────────────────────────────────

export async function createSession(
  userId: string,
  title?: string,
  vertical?: Vertical
): Promise<Session> {
  const session: Session = {
    sessionId: uuidv4(),
    userId,
    title: title || "New conversation",
    vertical: vertical || DEFAULT_VERTICAL,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await sessions.insertOne(session);
  return session;
}

export async function getSession(
  sessionId: string,
  userId: string
): Promise<Session | null> {
  return sessions.findOne({ sessionId, userId });
}

export async function listSessions(userId: string): Promise<Session[]> {
  return sessions.find({ userId }).sort({ updatedAt: -1 }).toArray();
}

export async function deleteSession(
  sessionId: string,
  userId: string
): Promise<void> {
  await messages.deleteMany({ sessionId });
  await sessions.deleteOne({ sessionId, userId });
}

export async function updateSessionTitle(
  sessionId: string,
  title: string
): Promise<void> {
  await sessions.updateOne(
    { sessionId },
    { $set: { title, updatedAt: new Date() } }
  );
}

// ── Message CRUD ───────────────────────────────────────────────────────────

export async function appendMessage(
  sessionId: string,
  msg: Omit<Message, "sessionId" | "createdAt">
): Promise<Message> {
  const message: Message = {
    ...msg,
    sessionId,
    createdAt: new Date(),
  };
  await messages.insertOne(message);
  // Touch session
  await sessions.updateOne(
    { sessionId },
    { $set: { updatedAt: new Date() } }
  );
  return message;
}

/**
 * Retrieve messages for a session, ordered by creation time.
 * When `limit` is provided, returns only the most recent N messages
 * (useful for windowing Claude API calls to control token usage).
 */
export async function getMessages(sessionId: string, limit?: number): Promise<Message[]> {
  if (limit && limit > 0) {
    // Fetch the most recent N messages (descending) then reverse to chronological order
    const recent = await messages
      .find({ sessionId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return recent.reverse();
  }
  return messages.find({ sessionId }).sort({ createdAt: 1 }).toArray();
}

// ── ACL Config CRUD ───────────────────────────────────────────────────────

export async function getAllToolAcls(): Promise<AclToolConfig[]> {
  return aclConfigs.find().sort({ toolName: 1 }).toArray();
}

export async function upsertToolAcls(
  toolName: string,
  acls: string[],
  updatedBy: string
): Promise<AclToolConfig> {
  const now = new Date();
  await aclConfigs.updateOne(
    { toolName },
    { $set: { acls, updatedAt: now, updatedBy } },
    { upsert: true }
  );
  return { toolName, acls, updatedAt: now, updatedBy };
}

export async function deleteToolAcl(toolName: string): Promise<void> {
  await aclConfigs.deleteOne({ toolName });
}

/** Build a tool_acls map for Redis sync (matches AclConfig.tool_acls shape) */
export async function getToolAclsMap(): Promise<Record<string, string[]>> {
  const all = await getAllToolAcls();
  const map: Record<string, string[]> = {};
  for (const entry of all) {
    map[entry.toolName] = entry.acls;
  }
  return map;
}

// ── ACL Global Config CRUD ───────────────────────────────────────────────

const DEFAULT_GLOBAL_CONFIG: Omit<AclGlobalConfig, "updatedAt" | "updatedBy"> = {
  default_policy: "open",
  public_tools: [],
  disabled_tools: [],
};

export async function getGlobalAclConfig(): Promise<AclGlobalConfig> {
  const doc = await aclGlobalConfig.findOne({});
  if (doc) return doc;
  // Return defaults if nothing configured yet
  return { ...DEFAULT_GLOBAL_CONFIG, updatedAt: new Date(), updatedBy: "system" };
}

export async function upsertGlobalAclConfig(
  config: Pick<AclGlobalConfig, "default_policy" | "public_tools" | "disabled_tools">,
  updatedBy: string
): Promise<AclGlobalConfig> {
  const now = new Date();
  const doc: AclGlobalConfig = { ...config, updatedAt: now, updatedBy };
  // Use a single-document pattern: always upsert with a fixed filter
  await aclGlobalConfig.updateOne(
    {},
    { $set: doc },
    { upsert: true }
  );
  return doc;
}

/** Build the global config object for Redis sync (without MongoDB metadata) */
export async function getGlobalAclConfigForRedis(): Promise<{
  default_policy: "open" | "deny";
  public_tools: string[];
  disabled_tools: string[];
}> {
  const config = await getGlobalAclConfig();
  return {
    default_policy: config.default_policy,
    public_tools: config.public_tools,
    disabled_tools: config.disabled_tools,
  };
}
