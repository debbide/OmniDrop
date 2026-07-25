import { getDb, auditEvents } from "@omnidrop/db";
import { newId } from "../lib/id.js";

export type AuditInput = {
  actorUserId?: string | null;
  actorType: "session" | "api_token" | "public" | "system";
  actorTokenId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown> | null;
};

export async function audit(input: AuditInput): Promise<void> {
  const db = getDb();
  await db.insert(auditEvents).values({
    id: newId("aud"),
    actorUserId: input.actorUserId ?? null,
    actorType: input.actorType,
    actorTokenId: input.actorTokenId ?? null,
    action: input.action,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    metaJson: input.meta ? JSON.stringify(input.meta) : null,
    createdAt: Date.now(),
  });
}
