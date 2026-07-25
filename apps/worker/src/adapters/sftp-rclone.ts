/**
 * Legacy re-exports — prefer @omnidrop/remote-fs createRemoteFs.
 * Kept so any old imports keep working during transition.
 */
export {
  createRcloneFromTarget as adapterForTarget,
  createRcloneRemoteFs,
} from "@omnidrop/remote-fs";

import {
  createRcloneFromTarget,
  type RemoteFsAdapter,
} from "@omnidrop/remote-fs";
import type { SftpConfig } from "@omnidrop/shared";

/** @deprecated use createRemoteFs from @omnidrop/remote-fs */
export function createSftpAdapter(opts: {
  config: SftpConfig;
  secret: { password?: string; privateKey?: string; passphrase?: string };
}): RemoteFsAdapter {
  return createRcloneFromTarget("sftp", opts.config as never, opts.secret as never);
}
