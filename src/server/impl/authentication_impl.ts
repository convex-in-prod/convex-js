import { Auth, MutationAuth } from "../authentication.js";
import { version } from "../../index.js";
import {
  ValueSyscall,
  performAsyncSyscall,
  performAsyncValueSyscall,
} from "./syscall.js";

export function setupAuth(requestId: string): Auth {
  return {
    getUserIdentity: async () => {
      return await performAsyncValueSyscall(
        ValueSyscall.Identity,
        [requestId],
        () => ({ requestId }),
        (result) => result,
      );
    },
  };
}

export function setupMutationAuth(requestId: string): MutationAuth {
  return {
    ...setupAuth(requestId),
    signJwt: async (options) => {
      // Signing has no typed value opcode; keep the JSON syscall even when
      // identity reads use the typed runtime boundary.
      return await performAsyncSyscall("1.0/signJwt", {
        requestId,
        version,
        ...options,
      });
    },
  };
}
