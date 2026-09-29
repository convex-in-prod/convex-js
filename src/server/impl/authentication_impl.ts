import { Auth } from "../authentication.js";
import { ValueSyscall, performAsyncValueSyscall } from "./syscall.js";

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
