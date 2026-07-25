import { TargetType, type PteroConfig } from "@omnidrop/shared";
import { createPterodactylRemoteFs } from "./pterodactyl.js";
import { createRcloneFromTarget } from "./rclone.js";
import type { RemoteFsAdapter, RemoteFsOptions } from "./types.js";
import { normalizeRemotePath } from "./jail.js";

export function getTargetJailRoot(config: Record<string, unknown>): string {
  return normalizeRemotePath(String(config.remotePath ?? "/"));
}

export function createRemoteFs(
  type: string,
  config: Record<string, unknown>,
  secret: Record<string, unknown>,
  opts?: RemoteFsOptions,
): RemoteFsAdapter {
  if (type === TargetType.PTERODACTYL) {
    return createPterodactylRemoteFs({
      config: config as PteroConfig,
      secret: secret as { apiKey: string },
    });
  }
  return createRcloneFromTarget(type, config, secret, opts);
}
