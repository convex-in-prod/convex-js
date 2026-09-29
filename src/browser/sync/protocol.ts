import type { UserIdentityAttributes } from "../../server/authentication.js";
export type { UserIdentityAttributes } from "../../server/authentication.js";
import { JSONValue, Base64 } from "../../values/index.js";
import { Long } from "../../vendor/long.js";

/**
 * Shared schema
 */

export function u64ToLong(encoded: EncodedU64): U64 {
  const integerBytes = Base64.toByteArray(encoded);
  return Long.fromBytesLE(Array.from(integerBytes));
}

export function longToU64(raw: U64): EncodedU64 {
  const integerBytes = new Uint8Array(raw.toBytesLE());
  return Base64.fromByteArray(integerBytes);
}

export function parseServerMessage(
  encoded: EncodedServerMessage,
): WireServerMessage {
  switch (encoded.type) {
    case "FatalError":
    case "AuthError":
    case "ActionResponse":
    case "TransitionChunk":
    case "Ping": {
      return { ...encoded };
    }
    case "MutationResponse": {
      if (encoded.success) {
        return { ...encoded, ts: u64ToLong(encoded.ts) };
      } else {
        return { ...encoded };
      }
    }
    case "Transition": {
      const serverPressure = parseServerPressure(encoded.serverPressure);
      return {
        ...encoded,
        ...(serverPressure === undefined ? {} : { serverPressure }),
        startVersion: {
          ...encoded.startVersion,
          ts: u64ToLong(encoded.startVersion.ts),
        },
        endVersion: {
          ...encoded.endVersion,
          ts: u64ToLong(encoded.endVersion.ts),
        },
      };
    }
    default: {
      encoded satisfies never;
    }
  }
  return undefined as never;
}

function parseServerPressure(encoded: unknown): ServerPressure | undefined {
  if (encoded === undefined) {
    return undefined;
  }
  if (typeof encoded !== "object" || encoded === null) {
    throw new Error("Invalid serverPressure in Transition");
  }

  const { kind, state, epoch, retryAfterMs, pendingQueryCount } =
    encoded as Record<string, unknown>;
  if (kind !== "degradable_query_capacity") {
    throw new Error("Invalid serverPressure in Transition");
  }
  const isU32 = (value: unknown): value is number =>
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff;
  const isPositiveU32 = (value: unknown): value is number =>
    isU32(value) && value > 0;

  if (state === undefined) {
    if (
      !isPositiveU32(retryAfterMs) ||
      epoch !== undefined ||
      pendingQueryCount !== undefined
    ) {
      throw new Error("Invalid serverPressure in Transition");
    }
    return { kind, retryAfterMs };
  }
  if (state === "active") {
    if (
      !isPositiveU32(epoch) ||
      !isPositiveU32(retryAfterMs) ||
      !isPositiveU32(pendingQueryCount)
    ) {
      throw new Error("Invalid serverPressure in Transition");
    }
    return { kind, state, epoch, retryAfterMs, pendingQueryCount };
  }
  if (state === "cleared") {
    if (
      !isPositiveU32(epoch) ||
      retryAfterMs !== undefined ||
      pendingQueryCount !== 0
    ) {
      throw new Error("Invalid serverPressure in Transition");
    }
    return { kind, state, epoch, pendingQueryCount };
  }
  throw new Error("Invalid serverPressure in Transition");
}

export function encodeClientMessage(
  message: ClientMessage,
): EncodedClientMessage {
  switch (message.type) {
    case "Authenticate":
    case "ModifyQuerySet":
    case "Mutation":
    case "Action":
    case "RetryDegradableQueries":
    case "Event": {
      return { ...message };
    }
    case "Connect": {
      if (message.maxObservedTimestamp !== undefined) {
        return {
          ...message,
          maxObservedTimestamp: longToU64(message.maxObservedTimestamp),
        };
      } else {
        return { ...message, maxObservedTimestamp: undefined };
      }
    }
    default: {
      message satisfies never;
    }
  }
  return undefined as never;
}

type U64 = Long;
type EncodedU64 = string;

/**
 * Unique nonnegative integer identifying a single query.
 */
export type QueryId = number; // nonnegative int

export type QuerySetVersion = number; // nonnegative int

export type RequestId = number; // nonnegative int

export type IdentityVersion = number; // nonnegative int

/**
 * A serialized representation of decisions made during a query's execution.
 *
 * A journal is produced when a query function first executes and is re-used
 * when a query is re-executed.
 *
 * Currently this is used to store pagination end cursors to ensure
 * that pages of paginated queries will always end at the same cursor. This
 * enables gapless, reactive pagination.
 *
 * `null` is used to represent empty journals.
 * @public
 */
export type QueryJournal = string | null;

/**
 * Client message schema
 */

/**
 * A query workload class that opts a client's root reactive queries into
 * temporary degradation when the backend is under pressure.
 *
 * @public
 */
export type QueryWorkloadClass = "degradable";

type Connect = {
  type: "Connect";
  sessionId: string;
  connectionCount: number;
  lastCloseReason: string | null;
  maxObservedTimestamp?: TS | undefined;
  clientTs: number;
  queryWorkloadClass?: QueryWorkloadClass | undefined;
  degradableQueryPressureVersion?: 1 | undefined;
};

export type AddQuery = {
  type: "Add";
  queryId: QueryId;
  udfPath: string;
  args: JSONValue[];
  journal?: QueryJournal | undefined;
  /**
   * @internal
   */
  componentPath?: string | undefined;
};

export type RemoveQuery = {
  type: "Remove";
  queryId: QueryId;
};

export type QuerySetModification = {
  type: "ModifyQuerySet";
  baseVersion: QuerySetVersion;
  newVersion: QuerySetVersion;
  modifications: (AddQuery | RemoveQuery)[];
};

export type MutationRequest = {
  type: "Mutation";
  requestId: RequestId;
  udfPath: string;
  args: JSONValue[];
  // Execute the mutation on a specific component.
  // Only admin auth is allowed to run mutations on non-root components.
  componentPath?: string | undefined;
};

export type ActionRequest = {
  type: "Action";
  requestId: RequestId;
  udfPath: string;
  args: JSONValue[];
  // Execute the action on a specific component.
  // Only admin auth is allowed to run actions on non-root components.
  componentPath?: string | undefined;
};

export type RetryDegradableQueries = {
  type: "RetryDegradableQueries";
  epoch: number;
};

export type AdminAuthentication = {
  type: "Authenticate";
  tokenType: "Admin";
  value: string;
  baseVersion: IdentityVersion;
  impersonating?: UserIdentityAttributes | undefined;
};

export type Authenticate =
  | AdminAuthentication
  | {
      type: "Authenticate";
      tokenType: "User";
      value: string;
      baseVersion: IdentityVersion;
    }
  | {
      type: "Authenticate";
      tokenType: "None";
      baseVersion: IdentityVersion;
    };

export type Event = {
  type: "Event";
  eventType: string;
  event: any;
};
export type ClientMessage =
  | Connect
  | Authenticate
  | QuerySetModification
  | MutationRequest
  | ActionRequest
  | RetryDegradableQueries
  | Event;

type EncodedConnect = Omit<Connect, "maxObservedTimestamp"> & {
  maxObservedTimestamp?: EncodedTS | undefined;
};

// It's not a big deal to add `| undefined` to any optional properties here because
// these messages are bound for JSON.stringify() serialization, which removes properties
// that are undefined.
type EncodedClientMessage =
  | EncodedConnect
  | Authenticate
  | QuerySetModification
  | MutationRequest
  | ActionRequest
  | RetryDegradableQueries
  | Event;

/**
 * Server message schema
 */
export type TS = U64;
type EncodedTS = EncodedU64;
type LogLines = string[];

/**
 * Temporary server pressure reported for degradable reactive queries.
 * `retryAfterMs` is a strictly positive unsigned 32-bit integer and is the
 * backend's automatic retry delay. Lifecycle `epoch` values are also positive
 * unsigned 32-bit integers; `pendingQueryCount` is positive for `active` and
 * zero for `cleared`. Lifecycle-capable applications should keep successful
 * subscriptions mounted until a matching `cleared` event. A transition with
 * no pressure metadata does not clear an active epoch. The variant without a
 * `state` field is legacy metadata and has no explicit clear event.
 *
 * @public
 */
export type ServerPressure =
  | {
      kind: "degradable_query_capacity";
      retryAfterMs: number;
    }
  | {
      kind: "degradable_query_capacity";
      state: "active";
      epoch: number;
      retryAfterMs: number;
      pendingQueryCount: number;
    }
  | {
      kind: "degradable_query_capacity";
      state: "cleared";
      epoch: number;
      pendingQueryCount: 0;
    };

export type StateVersion = {
  querySet: QuerySetVersion;
  ts: TS;
  identity: IdentityVersion;
};
type EncodedStateVersion = Omit<StateVersion, "ts"> & { ts: EncodedTS };

type StateModification =
  | {
      type: "QueryUpdated";
      queryId: QueryId;
      value: JSONValue;
      logLines: LogLines;
      journal: QueryJournal;
    }
  | {
      type: "QueryFailed";
      queryId: QueryId;
      errorMessage: string;
      logLines: LogLines;
      errorData: JSONValue;
      journal: QueryJournal;
    }
  | {
      type: "QueryRemoved";
      queryId: QueryId;
    };

export type Transition = {
  type: "Transition";
  startVersion: StateVersion;
  endVersion: StateVersion;
  modifications: StateModification[];
  serverPressure?: ServerPressure;
  clientClockSkew?: number;
  serverTs?: number;
};

export type TransitionChunk = {
  type: "TransitionChunk";
  chunk: string;
  partNumber: number;
  totalParts: number;
  transitionId: string;
};

type MutationSuccess = {
  type: "MutationResponse";
  requestId: RequestId;
  success: true;
  result: JSONValue;
  ts: TS;
  logLines: LogLines;
};
type MutationFailed = {
  type: "MutationResponse";
  requestId: RequestId;
  success: false;
  result: string;
  logLines: LogLines;
  errorData?: JSONValue;
};
export type MutationResponse = MutationSuccess | MutationFailed;
type ActionSuccess = {
  type: "ActionResponse";
  requestId: RequestId;
  success: true;
  result: JSONValue;
  logLines: LogLines;
};
type ActionFailed = {
  type: "ActionResponse";
  requestId: RequestId;
  success: false;
  result: string;
  logLines: LogLines;
  errorData?: JSONValue;
};
export type ActionResponse = ActionSuccess | ActionFailed;
export type AuthError = {
  type: "AuthError";
  error: string;
  baseVersion: IdentityVersion;
  // True if this error is in response to processing a new `Authenticate` message.
  // Other AuthErrors may occur due to executing a function with expired auth and
  // should be handled differently.
  authUpdateAttempted: boolean;
};
type FatalError = {
  type: "FatalError";
  error: string;
};
type Ping = {
  type: "Ping";
};

// Server Messages without the messages only visible to WebSocketManager
export type ServerMessage =
  | Transition
  | MutationResponse
  | ActionResponse
  | FatalError
  | AuthError;

export type WireServerMessage =
  | Transition
  | TransitionChunk
  | MutationResponse
  | ActionResponse
  | FatalError
  | AuthError
  | Ping;

type EncodedTransition = Omit<Transition, "startVersion" | "endVersion"> & {
  startVersion: EncodedStateVersion;
  endVersion: EncodedStateVersion;
};
type EncodedMutationSuccess = Omit<MutationSuccess, "ts"> & { ts: EncodedTS };
type EncodedMutationResponse = MutationFailed | EncodedMutationSuccess;

type EncodedServerMessage =
  | EncodedTransition
  | TransitionChunk
  | EncodedMutationResponse
  | ActionResponse
  | FatalError
  | AuthError
  | Ping;
