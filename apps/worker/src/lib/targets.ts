import { eq } from "drizzle-orm";
import { decryptJson } from "@omnidrop/crypto";
import { getDb, credentials, targets } from "@omnidrop/db";
import { workerConfig } from "../config.js";

export async function loadTargetWithSecret(targetId: string) {
  const db = getDb();
  const row = await db.select().from(targets).where(eq(targets.id, targetId)).get();
  if (!row) throw new Error(`Target ${targetId} not found`);
  const cred = await db
    .select()
    .from(credentials)
    .where(eq(credentials.id, row.credentialId))
    .get();
  if (!cred) throw new Error(`Credential for target ${targetId} missing`);
  const secret = decryptJson<Record<string, unknown>>(
    workerConfig.OMNIDROP_DATA_KEY,
    cred,
  );
  return {
    target: row,
    config: JSON.parse(row.configJson) as Record<string, unknown>,
    secret,
    credentialType: cred.type,
  };
}
