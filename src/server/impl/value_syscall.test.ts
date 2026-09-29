import { afterEach, expect, test, vi } from "vitest";
import { setupWriter } from "./database_impl.js";
import {
  setupMutationScheduler,
  setupActionScheduler,
} from "./scheduler_impl.js";
import { makeFunctionReference } from "../api.js";
import { GenericId } from "../../values/index.js";
import { ConvexError } from "../../values/errors.js";
import { ValueSyscall, performAsyncValueSyscall } from "./syscall.js";

afterEach(() => vi.unstubAllGlobals());

for (const mode of ["typed", "value", "json"] as const) {
  test(`database writes and scheduling preserve ${mode} transport semantics`, async () => {
    const calls: { op: string; args: unknown }[] = [];
    vi.stubGlobal("Convex", {
      asyncSyscall: async (op: string, args: string) => {
        calls.push({ op, args: JSON.parse(args) });
        return op === "1.0/insert" ? '{"_id":"new-id"}' : '"job-id"';
      },
      ...(mode === "typed"
        ? {
            asyncSyscallTyped: async (op: number, args: readonly unknown[]) => {
              calls.push({ op: String(op), args });
              return op === ValueSyscall.Insert ? { _id: "new-id" } : "job-id";
            },
          }
        : mode === "value"
          ? {
              asyncSyscallValueArgs: async (
                op: string,
                args: Record<string, unknown>,
              ) => {
                calls.push({ op, args });
                return op === "1.0/insert" ? { _id: "new-id" } : "job-id";
              },
            }
          : {}),
    });
    const db = setupWriter();
    expect(await db.insert("documents", { n: 1n })).toBe("new-id");
    await db.patch("documents", "id" as GenericId<"documents">, {
      removed: undefined,
      n: 1n,
    });
    expect(calls[0].args).toEqual(
      mode === "typed"
        ? ["documents", { n: 1n }]
        : {
            table: "documents",
            value: { n: mode === "value" ? 1n : { $integer: "AQAAAAAAAAA=" } },
          },
    );
    expect(calls[1].args).toEqual(
      mode === "typed"
        ? ["id", { removed: undefined, n: 1n }, "documents"]
        : {
            id: "id",
            table: "documents",
            value: {
              removed: mode === "value" ? undefined : { $undefined: null },
              n: mode === "value" ? 1n : { $integer: "AQAAAAAAAAA=" },
            },
          },
    );
    const fn = makeFunctionReference<"mutation">("jobs:run");
    expect(await setupMutationScheduler().runAt(1234, fn, { n: 2 })).toBe(
      "job-id",
    );
    expect(
      await setupActionScheduler("request").runAt(1234, fn, { n: 2 }),
    ).toBe("job-id");
    expect(calls[2].args).toEqual(
      mode === "typed"
        ? [1.234, { n: 2 }, expect.any(String), { name: "jobs:run" }]
        : {
            ts: 1.234,
            args: { n: 2 },
            version: expect.any(String),
            name: "jobs:run",
          },
    );
    expect(calls[3]).toEqual({
      op: "1.0/actions/schedule",
      args: {
        ts: 1.234,
        args: { n: 2 },
        version: expect.any(String),
        name: "jobs:run",
        requestId: "request",
      },
    });
  });
}

test("typed syscalls keep error data and never invoke the JSON fallback", async () => {
  const data = { n: 1n };
  vi.stubGlobal("Convex", {
    asyncSyscallTyped: () => Promise.reject({ message: "failure", data }),
  });
  const result = performAsyncValueSyscall(
    ValueSyscall.Get,
    ["id", undefined, false, "version"],
    () => {
      throw new Error("Unexpected JSON fallback");
    },
    (value) => value,
  );
  await expect(result).rejects.toBeInstanceOf(ConvexError);
  await expect(result).rejects.toMatchObject({ data });
});
