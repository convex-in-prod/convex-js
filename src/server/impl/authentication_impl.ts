import { Auth } from "../authentication.js";
import { performAsyncValueSyscall } from "./syscall.js";

export function setupAuth(requestId: string): Auth {
  return {
    getUserIdentity: async () => {
      return await performAsyncValueSyscall(
        "1.0/getUserIdentity",
        { requestId },
        () => ({ requestId }),
        (result) => result,
      );
    },
  };
}
