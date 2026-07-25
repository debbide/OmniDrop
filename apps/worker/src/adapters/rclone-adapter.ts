/** @deprecated use @omnidrop/remote-fs */
export {
  createRcloneRemoteFs,
  createRcloneFromTarget,
  createRcloneFromTarget as adapterForTarget,
  createRemoteFs,
} from "@omnidrop/remote-fs";

import {
  createRcloneFromTarget,
  type RemoteFsAdapter,
} from "@omnidrop/remote-fs";
import type { FtpConfig, SftpConfig, WebdavConfig } from "@omnidrop/shared";

export function createSftpAdapter(opts: {
  config: SftpConfig;
  secret: Record<string, unknown>;
}): RemoteFsAdapter {
  return createRcloneFromTarget("sftp", opts.config as never, opts.secret);
}

export function createFtpAdapter(opts: {
  config: FtpConfig;
  secret: Record<string, unknown>;
}): RemoteFsAdapter {
  return createRcloneFromTarget("ftp", opts.config as never, opts.secret);
}

export function createWebdavAdapter(opts: {
  config: WebdavConfig;
  secret: Record<string, unknown>;
}): RemoteFsAdapter {
  return createRcloneFromTarget("webdav", opts.config as never, opts.secret);
}
