import { openDatabase, getRawClient, applyPragmas, type Db } from "./client.js";
import { BOOTSTRAP_SQL } from "./bootstrap-sql.js";

async function tableColumns(table: string): Promise<Set<string>> {
  const client = getRawClient();
  const result = await client.execute(`PRAGMA table_info(${table})`);
  const cols = new Set<string>();
  for (const row of result.rows) {
    const name = String((row as Record<string, unknown>).name ?? row[1] ?? "");
    if (name) cols.add(name);
  }
  return cols;
}

async function addColumnIfMissing(
  table: string,
  column: string,
  ddl: string,
): Promise<void> {
  const cols = await tableColumns(table);
  if (!cols.has(column)) {
    await getRawClient().execute(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/** Open DB and ensure schema exists (bootstrap + additive migrations). */
export async function ensureDatabase(databasePath: string): Promise<Db> {
  const db = openDatabase(databasePath);
  await applyPragmas();
  const client = getRawClient();
  const statements = BOOTSTRAP_SQL.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await client.execute(stmt);
  }

  // Additive upgrades for existing DBs created before Phase 2
  await addColumnIfMissing("sessions", "user_agent", "user_agent TEXT");
  await addColumnIfMissing("sessions", "ip", "ip TEXT");
  await addColumnIfMissing("sessions", "last_seen_at", "last_seen_at INTEGER");
  await addColumnIfMissing("sessions", "revoked_at", "revoked_at INTEGER");
  await addColumnIfMissing("jobs", "artifact_id", "artifact_id TEXT");
  await addColumnIfMissing("artifacts", "note", "note TEXT");

  return db;
}
