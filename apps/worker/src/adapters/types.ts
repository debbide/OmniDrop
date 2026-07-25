export type {
  RemoteFsAdapter,
  RemoteFsAdapter as UploadAdapter,
  UploadParams,
  DownloadParams,
  RemoteEntry,
} from "@omnidrop/remote-fs";

export type UploadProgress = {
  bytesDone: number;
  bytesTotal: number;
};
