import {
  FileMetadata,
  StorageActionWriter,
  FileStorageId,
  StorageReader,
  StorageWriter,
} from "../storage.js";
import { version } from "../../index.js";
import { performAsyncValueSyscall, performJsSyscall } from "./syscall.js";
import { validateArg } from "./validate.js";

export function setupStorageReader(requestId: string): StorageReader {
  return {
    getUrl: async (storageId: FileStorageId) => {
      validateArg(storageId, 1, "getUrl", "storageId");
      const args = { requestId, version, storageId };
      return await performAsyncValueSyscall(
        "1.0/storageGetUrl",
        args,
        () => args,
        (result) => result,
      );
    },
    getMetadata: async (storageId: FileStorageId): Promise<FileMetadata> => {
      const args = { requestId, version, storageId };
      return await performAsyncValueSyscall<FileMetadata>(
        "1.0/storageGetMetadata",
        args,
        () => args,
        (result) => result,
      );
    },
  };
}

export function setupStorageWriter(requestId: string): StorageWriter {
  const reader = setupStorageReader(requestId);
  return {
    generateUploadUrl: async () => {
      const args = { requestId, version };
      return await performAsyncValueSyscall(
        "1.0/storageGenerateUploadUrl",
        args,
        () => args,
        (result) => result,
      );
    },
    delete: async (storageId: FileStorageId) => {
      const args = { requestId, version, storageId };
      await performAsyncValueSyscall(
        "1.0/storageDelete",
        args,
        () => args,
        () => undefined,
      );
    },
    getUrl: reader.getUrl,
    getMetadata: reader.getMetadata,
  };
}

export function setupStorageActionWriter(
  requestId: string,
): StorageActionWriter {
  const writer = setupStorageWriter(requestId);
  return {
    ...writer,
    store: async (blob: Blob, options?: { sha256?: string }) => {
      return await performJsSyscall("storage/storeBlob", {
        requestId,
        version,
        blob,
        options,
      });
    },
    get: async (storageId: FileStorageId) => {
      return await performJsSyscall("storage/getBlob", {
        requestId,
        version,
        storageId,
      });
    },
  };
}
