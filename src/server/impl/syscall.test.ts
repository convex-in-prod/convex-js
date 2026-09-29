import { afterEach, expect, test, vi } from "vitest";
import { ConvexError, convexToJson } from "../../values/index.js";
import { makeFunctionReference } from "../api.js";
import { mutationGeneric } from "./registration_impl.js";

afterEach(() => vi.unstubAllGlobals());

for (const mode of ["typed", "value", "object", "json"] as const) {
  test.each([undefined, null, false, { count: 7n }])(
    `${mode} syscall errors retain their cause through registration (data: %s)`,
    async (data) => {
      const original = Object.assign(new Error("nested function failed"), {
        data:
          data === undefined || mode === "typed" || mode === "value"
            ? data
            : convexToJson(data),
      });
      const reject = vi.fn(() => Promise.reject(original));
      vi.stubGlobal("Convex", {
        asyncSyscall: reject,
        ...(mode === "typed" ? { asyncSyscallTyped: reject } : {}),
        ...(mode === "value" ? { asyncSyscallValueArgs: reject } : {}),
        ...(mode === "object" ? { asyncSyscallObjectArgs: reject } : {}),
      });
      const mutation = mutationGeneric(async (ctx) => {
        try {
          return await ctx.runQuery(
            makeFunctionReference<"query">("child:read"),
            {},
          );
        } catch (error) {
          if (data !== undefined) {
            expect(error).toBeInstanceOf(ConvexError);
            expect(error).toHaveProperty("data", data);
          }
          throw error;
        }
      });
      for (const invocation of [
        () => mutation.invokeMutationValue({}),
        () => mutation.invokeMutation("[{}]"),
      ]) {
        await expect(invocation()).rejects.toSatisfy((error: Error) => {
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBe(original);
          expect(error.message).toBe(original.message);
          expect(error.cause).toBe(original);
          expect(Object.getOwnPropertyDescriptor(error, "cause")).toEqual({
            value: original,
            configurable: true,
            enumerable: false,
            writable: true,
          });
          if (data !== undefined) {
            expect(error).toBeInstanceOf(ConvexError);
            expect(error).toHaveProperty(
              "data",
              JSON.stringify(convexToJson(data)),
            );
          } else {
            expect(error).not.toBeInstanceOf(ConvexError);
          }
          return true;
        });
      }
      expect(reject).toHaveBeenCalledTimes(2);
    },
  );
}
