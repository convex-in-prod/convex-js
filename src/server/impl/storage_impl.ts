import {
  FileMetadata,
  StorageActionWriter,
  FileStorageId,
  StorageReader,
  StorageWriter,
} from "../storage.js";
import { version } from "../../index.js";
import { fromByteArray } from "../../values/base64.js";
import {
  ValueSyscall,
  performAsyncSyscall,
  performAsyncValueSyscall,
  performJsSyscall,
} from "./syscall.js";
import { validateArg } from "./validate.js";

export function setupStorageReader(requestId: string): StorageReader {
  return {
    getUrl: async (storageId: FileStorageId) => {
      validateArg(storageId, 1, "getUrl", "storageId");
      return await performAsyncValueSyscall(
        ValueSyscall.StorageUrl,
        [storageId, requestId, version],
        () => ({ requestId, version, storageId }),
        (result) => result,
      );
    },
    getMetadata: async (storageId: FileStorageId): Promise<FileMetadata> => {
      return await performAsyncValueSyscall<FileMetadata>(
        ValueSyscall.StorageMetadata,
        [storageId, requestId, version],
        () => ({ requestId, version, storageId }),
        (result) => result,
      );
    },
  };
}

export function setupStorageWriter(requestId: string): StorageWriter {
  const reader = setupStorageReader(requestId);
  return {
    generateUploadUrl: async () => {
      return await performAsyncValueSyscall(
        ValueSyscall.StorageUploadUrl,
        [requestId, version],
        () => ({ requestId, version }),
        (result) => result,
      );
    },
    delete: async (storageId: FileStorageId) => {
      await performAsyncValueSyscall(
        ValueSyscall.StorageDelete,
        [storageId, requestId, version],
        () => ({ requestId, version, storageId }),
        () => undefined,
      );
    },
    store: async (blob: Blob, options?: { sha256?: string }) => {
      if (!(blob instanceof Blob)) {
        throw new Error(
          "store() expects a Blob. If you are trying to store a Request, `await request.blob()` will give you the correct input.",
        );
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return await performAsyncSyscall("1.0/storageStore", {
        requestId,
        version,
        blob: fromByteArray(bytes),
        contentType: blob.type,
        sha256: options?.sha256,
      });
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
