export type RemoteEntryType = "file" | "dir";

export type RemoteEntry = {
  name: string;
  path: string;
  type: RemoteEntryType;
  size?: number | null;
  modifiedAt?: number | null;
};

export type UploadParams = {
  localPath: string;
  remoteDir: string;
  fileName: string;
  overwrite?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: { bytesDone: number; bytesTotal: number }) => void | Promise<void>;
};

export type DownloadParams = {
  remotePath: string;
  localPath: string;
  signal?: AbortSignal;
  onProgress?: (p: { bytesDone: number; bytesTotal: number }) => void | Promise<void>;
};

export type RemoteFsAdapter = {
  testConnection(): Promise<{ ok: boolean; message: string }>;
  list(dirPath: string): Promise<RemoteEntry[]>;
  mkdir(dirPath: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  delete(paths: string[], opts?: { recursive?: boolean }): Promise<void>;
  upload(params: UploadParams): Promise<{ remoteFinalPath: string }>;
  download(params: DownloadParams): Promise<void>;
};

export type RemoteFsOptions = {
  rclonePath?: string;
  listLimit?: number;
};
