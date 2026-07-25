import { closeDatabase, openDatabase, getRawClient, applyPragmas } from "./client.js";
import { BOOTSTRAP_SQL } from "./bootstrap-sql.js";

export async function runMigrations(databasePath: string): Promise<void> {
  openDatabase(databasePath);
  await applyPragmas();
  const client = getRawClient();
  const statements = BOOTSTRAP_SQL.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await client.execute(stmt);
  }
}

const isMain =
  process.argv[1]?.endsWith("migrate.ts") ||
  process.argv[1]?.endsWith("migrate.js");

if (isMain) {
  const databasePath = process.env.DATABASE_PATH ?? "./data/db/omnidrop.sqlite";
  console.log(`[db] Migrating ${databasePath}`);
  await runMigrations(databasePath);
  closeDatabase();
  console.log("[db] Done");
}
