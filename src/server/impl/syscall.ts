import { ConvexError } from "../../values/errors.js";
import { jsonToConvex } from "../../values/value.js";

declare const Convex: {
  syscall: (op: string, jsonArgs: string) => string;
  asyncSyscall: (op: string, jsonArgs: string) => Promise<string>;
  syscallObjectArgs?: (op: string, args: Record<string, any>) => string;
  asyncSyscallObjectArgs?: (
    op: string,
    args: Record<string, any>,
  ) => Promise<string>;
  asyncSyscallValueArgs?: (
    op: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  asyncSyscallTyped?: (
    op: number,
    args: readonly unknown[],
  ) => Promise<unknown>;
  syscallTyped?: (op: number, args: readonly unknown[]) => unknown;
  jsSyscall: (op: string, args: Record<string, any>) => any;
};
/**
 * Perform a syscall with a JSON-encodable object and parse its JSON response.
 * The runtime may accept the object directly or require a JSON string.
 * If one of your arguments is a Convex value, you must call `convexToJson` on it
 * before passing it to this function, and if the return value has a Convex value, you're
 * also responsible for calling `jsonToConvex`: This layer only deals in JSON.
 */

export function performSyscall(op: string, arg: Record<string, any>): any {
  if (typeof Convex === "undefined" || Convex.syscall === undefined) {
    throw new Error(
      "The Convex database and auth objects are being used outside of a Convex backend. " +
        "Did you mean to use `useQuery` or `useMutation` to call a Convex function?",
    );
  }
  const resultStr =
    Convex.syscallObjectArgs === undefined
      ? Convex.syscall(op, JSON.stringify(arg))
      : Convex.syscallObjectArgs(op, arg);
  return JSON.parse(resultStr);
}

export async function performAsyncSyscall(
  op: string,
  arg: Record<string, any>,
): Promise<any> {
  if (typeof Convex === "undefined" || Convex.asyncSyscall === undefined) {
    throw new Error(
      "The Convex database and auth objects are being used outside of a Convex backend. " +
        "Did you mean to use `useQuery` or `useMutation` to call a Convex function?",
    );
  }
  let resultStr;
  try {
    resultStr =
      Convex.asyncSyscallObjectArgs === undefined
        ? await Convex.asyncSyscall(op, JSON.stringify(arg))
        : await Convex.asyncSyscallObjectArgs(op, arg);
  } catch (e: any) {
    // Rethrow the exception to attach stack trace starting from here.
    // If the error came from JS it will include its own stack trace in the message.
    // If it came from Rust it won't.

    // This only happens if we're propagating ConvexErrors
    if (e.data !== undefined) {
      const rethrown = new ConvexError(e.message);
      rethrown.data = jsonToConvex(e.data);
      throw rethrown;
    }
    throw new Error(e.message);
  }
  return JSON.parse(resultStr);
}

// The tuple order is shared with the typed runtime. Legacy request objects are
// constructed only when that entry point is unavailable.
export const enum ValueSyscall {
  Get = 1,
  Insert = 2,
  Patch = 3,
  Replace = 4,
  Remove = 5,
  Count = 6,
  Collect = 7,
  Page = 8,
  StreamNext = 9,
  Identity = 10,
  FunctionMetadata = 11,
  DeploymentMetadata = 12,
  TransactionMetrics = 13,
  RequestMetadata = 14,
  StorageUrl = 15,
  StorageMetadata = 16,
  StorageDelete = 17,
  StorageUploadUrl = 18,
  CancelJob = 19,
  RunUdf = 20,
  Schedule = 21,
  FunctionHandle = 22,
}

const valueOperations: Record<
  ValueSyscall,
  { name: string; fields: readonly string[] }
> = {
  [ValueSyscall.Get]: {
    name: "1.0/get",
    fields: ["id", "table", "isSystem", "version"],
  },
  [ValueSyscall.Insert]: { name: "1.0/insert", fields: ["table", "value"] },
  [ValueSyscall.Patch]: {
    name: "1.0/shallowMerge",
    fields: ["id", "value", "table"],
  },
  [ValueSyscall.Replace]: {
    name: "1.0/replace",
    fields: ["id", "value", "table"],
  },
  [ValueSyscall.Remove]: { name: "1.0/remove", fields: ["id", "table"] },
  [ValueSyscall.Count]: { name: "1.0/count", fields: ["table"] },
  [ValueSyscall.Collect]: {
    name: "1.0/queryCollect",
    fields: ["query", "version"],
  },
  [ValueSyscall.Page]: {
    name: "1.0/queryPage",
    fields: [
      "query",
      "cursor",
      "endCursor",
      "pageSize",
      "maximumRowsRead",
      "maximumBytesRead",
      "version",
    ],
  },
  [ValueSyscall.StreamNext]: {
    name: "1.0/queryStreamNext",
    fields: ["queryId"],
  },
  [ValueSyscall.Identity]: {
    name: "1.0/getUserIdentity",
    fields: ["requestId"],
  },
  [ValueSyscall.FunctionMetadata]: {
    name: "1.0/getFunctionMetadata",
    fields: [],
  },
  [ValueSyscall.DeploymentMetadata]: {
    name: "1.0/getDeploymentMetadata",
    fields: [],
  },
  [ValueSyscall.TransactionMetrics]: {
    name: "1.0/getTransactionMetrics",
    fields: [],
  },
  [ValueSyscall.RequestMetadata]: {
    name: "1.0/getRequestMetadata",
    fields: [],
  },
  [ValueSyscall.StorageUrl]: {
    name: "1.0/storageGetUrl",
    fields: ["storageId", "requestId", "version"],
  },
  [ValueSyscall.StorageMetadata]: {
    name: "1.0/storageGetMetadata",
    fields: ["storageId", "requestId", "version"],
  },
  [ValueSyscall.StorageDelete]: {
    name: "1.0/storageDelete",
    fields: ["storageId", "requestId", "version"],
  },
  [ValueSyscall.StorageUploadUrl]: {
    name: "1.0/storageGenerateUploadUrl",
    fields: ["requestId", "version"],
  },
  [ValueSyscall.CancelJob]: { name: "1.0/cancel_job", fields: ["id"] },
  [ValueSyscall.RunUdf]: {
    name: "1.0/runUdf",
    fields: ["udfType", "args", "transactionLimits"],
  },
  [ValueSyscall.Schedule]: {
    name: "1.0/schedule",
    fields: ["ts", "args", "version"],
  },
  [ValueSyscall.FunctionHandle]: {
    name: "1.0/createFunctionHandle",
    fields: ["version"],
  },
};

/** The Wasm value ABI returns SDK-visible values; V8 keeps its JSON contract. */
export async function performAsyncValueSyscall<T>(
  op: ValueSyscall,
  args: readonly unknown[],
  jsonArgs: () => Record<string, unknown>,
  fromJson: (value: any) => T,
): Promise<T> {
  if (
    typeof Convex === "undefined" ||
    (Convex.asyncSyscallTyped === undefined &&
      Convex.asyncSyscallValueArgs === undefined)
  ) {
    return fromJson(
      await performAsyncSyscall(valueOperations[op].name, jsonArgs()),
    );
  }
  try {
    if (Convex.asyncSyscallTyped !== undefined) {
      return (await Convex.asyncSyscallTyped(op, args)) as T;
    }
    const { name, fields } = valueOperations[op];
    const valueArgs: Record<string, unknown> = {};
    for (let i = 0; i < fields.length; i++) valueArgs[fields[i]] = args[i];
    if (
      op === ValueSyscall.RunUdf ||
      op === ValueSyscall.Schedule ||
      op === ValueSyscall.FunctionHandle
    ) {
      const address = args[fields.length];
      if (address === null || typeof address !== "object") {
        throw new Error("Invalid value syscall function address");
      }
      Object.assign(valueArgs, address);
    }
    return (await Convex.asyncSyscallValueArgs!(name, valueArgs)) as T;
  } catch (e: unknown) {
    if (
      e === null ||
      typeof e !== "object" ||
      !("message" in e) ||
      typeof e.message !== "string"
    )
      throw e;
    if ("data" in e && e.data !== undefined) {
      const rethrown = new ConvexError<
        ConstructorParameters<typeof ConvexError>[0]
      >(e.message);
      rethrown.data = e.data as ConstructorParameters<typeof ConvexError>[0];
      throw rethrown;
    }
    throw new Error(e.message);
  }
}

export function performQueryStreamSyscall(
  op: "open" | "close",
  queryOrId: unknown,
  version?: string,
): number | undefined {
  if (typeof Convex !== "undefined" && Convex.syscallTyped !== undefined) {
    return Convex.syscallTyped(op === "open" ? 1 : 2, [queryOrId, version]) as
      | number
      | undefined;
  }
  if (op === "open") {
    return performSyscall("1.0/queryStream", { query: queryOrId, version })
      .queryId;
  }
  performSyscall("1.0/queryCleanup", { queryId: queryOrId });
}

/**
 * Call into a "JS" syscall. Like `performSyscall`, this calls a dynamically linked
 * function set up in the Convex function execution. Unlike `performSyscall`, the
 * arguments do not need to be JSON-encodable and neither does the return value.
 *
 * @param op
 * @param arg
 * @returns
 */
export function performJsSyscall(op: string, arg: Record<string, any>): any {
  if (typeof Convex === "undefined" || Convex.jsSyscall === undefined) {
    throw new Error(
      "The Convex database and auth objects are being used outside of a Convex backend. " +
        "Did you mean to use `useQuery` or `useMutation` to call a Convex function?",
    );
  }
  return Convex.jsSyscall(op, arg);
}
