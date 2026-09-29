import {
  JSONValue,
  Value,
  convexOrUndefinedToJson,
} from "../../values/value.js";

declare const Convex: {
  typedQueryArgs?: true;
  queryRecord?: (kind: number, first: unknown, second?: unknown) => QueryRecord;
  captureQueryValue?: (value: Value) => ArrayBuffer;
};

export type QueryValue = JSONValue | ArrayBuffer | undefined;

export function queryValueArg(value: Value | undefined): QueryValue {
  if (typeof Convex === "undefined" || Convex.typedQueryArgs !== true) {
    return convexOrUndefinedToJson(value);
  }
  if (value === undefined) return undefined;
  if (Convex.captureQueryValue === undefined) {
    throw new Error("Typed query value capture is unavailable");
  }
  // Query builders snapshot literals at construction, before callers can mutate them.
  return Convex.captureQueryValue(value);
}

// Native records are opaque and immutable; only the runtime can create them.
declare const queryRecordBrand: unique symbol;
export type QueryRecord = { readonly [queryRecordBrand]: true };

export function queryRecordBuilder() {
  return typeof Convex === "undefined" ? undefined : Convex.queryRecord;
}
