import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema.js";

export type Db = LibSQLDatabase<typeof schema>;

let singleton: Db | null = null;
let rawClient: Client | null = null;

function toFileUrl(databasePath: string): string {
  const abs = path.resolve(databasePath).replace(/\\/g, "/");
  return abs.startsWith("/") ? `file://${abs}` : `file:///${abs}`;
}

export function openDatabase(databasePath: string): Db {
  if (singleton) return singleton;

  const dir = path.dirname(path.resolve(databasePath));
  fs.mkdirSync(dir, { recursive: true });

  const client = createClient({
    url: toFileUrl(databasePath),
  });

  rawClient = client;
  singleton = drizzle(client, { schema });
  return singleton;
}

export async function applyPragmas(): Promise<void> {
  const client = getRawClient();
  await client.execute("PRAGMA journal_mode = WAL;");
  await client.execute("PRAGMA busy_timeout = 5000;");
  await client.execute("PRAGMA foreign_keys = ON;");
  await client.execute("PRAGMA synchronous = NORMAL;");
}

export function getDb(): Db {
  if (!singleton) {
    throw new Error("Database not initialized. Call openDatabase() first.");
  }
  return singleton;
}

export function getRawClient(): Client {
  if (!rawClient) {
    throw new Error("Database not initialized. Call openDatabase() first.");
  }
  return rawClient;
}

export function closeDatabase(): void {
  if (rawClient) {
    rawClient.close();
    rawClient = null;
    singleton = null;
  }
}
