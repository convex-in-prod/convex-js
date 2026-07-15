import { describe, expect, expectTypeOf, test } from "vitest";
import type {
  BaseConvexClientOptions,
  QueryWorkloadClass,
  ServerPressure,
  ServerPressureHandler,
} from "../index.js";
import type {
  QueryWorkloadClass as ReactQueryWorkloadClass,
  ServerPressure as ReactServerPressure,
  ServerPressureHandler as ReactServerPressureHandler,
} from "../../react/index.js";
import { Long } from "../../vendor/long.js";
import {
  ClientMessage,
  encodeClientMessage,
  longToU64,
  parseServerMessage,
} from "./protocol.js";

type ConnectMessage = Extract<ClientMessage, { type: "Connect" }>;

function connectMessage(
  queryWorkloadClass?: QueryWorkloadClass,
): ConnectMessage {
  return {
    type: "Connect",
    sessionId: "session",
    connectionCount: 0,
    lastCloseReason: null,
    clientTs: 123,
    ...(queryWorkloadClass === undefined ? {} : { queryWorkloadClass }),
  };
}

function parseTransition({
  serverPressure,
  includeServerPressure = true,
  extra,
}: {
  serverPressure?: unknown;
  includeServerPressure?: boolean;
  extra?: Record<string, unknown>;
} = {}) {
  const encoded = {
    type: "Transition",
    startVersion: {
      querySet: 0,
      ts: longToU64(Long.fromNumber(0)),
      identity: 0,
    },
    endVersion: {
      querySet: 0,
      ts: longToU64(Long.fromNumber(0)),
      identity: 0,
    },
    modifications: [],
    ...(includeServerPressure ? { serverPressure } : {}),
    ...extra,
  };
  const parsed = parseServerMessage(
    encoded as unknown as Parameters<typeof parseServerMessage>[0],
  );
  if (parsed.type !== "Transition") {
    throw new Error(`Expected Transition, got ${parsed.type}`);
  }
  return parsed;
}

describe("degradable client protocol", () => {
  test("exports only the degradable workload class through client options", () => {
    expectTypeOf<QueryWorkloadClass>().toEqualTypeOf<"degradable">();
    expectTypeOf<BaseConvexClientOptions["queryWorkloadClass"]>().toEqualTypeOf<
      QueryWorkloadClass | undefined
    >();
    expectTypeOf<ServerPressureHandler>().toEqualTypeOf<
      (pressure: ServerPressure) => void | Promise<void>
    >();
    expectTypeOf<ReactQueryWorkloadClass>().toEqualTypeOf<QueryWorkloadClass>();
    expectTypeOf<ReactServerPressure>().toEqualTypeOf<ServerPressure>();
    expectTypeOf<ReactServerPressureHandler>().toEqualTypeOf<ServerPressureHandler>();
  });

  test("omitting the workload class preserves the existing Connect bytes", () => {
    expect(JSON.stringify(encodeClientMessage(connectMessage()))).toBe(
      '{"type":"Connect","sessionId":"session","connectionCount":0,"lastCloseReason":null,"clientTs":123}',
    );
  });

  test("serializes the degradable workload class on Connect", () => {
    expect(
      JSON.stringify(encodeClientMessage(connectMessage("degradable"))),
    ).toBe(
      '{"type":"Connect","sessionId":"session","connectionCount":0,"lastCloseReason":null,"clientTs":123,"queryWorkloadClass":"degradable"}',
    );
  });

  test("decodes bounded degradable query pressure", () => {
    const parsed = parseTransition({
      serverPressure: {
        kind: "degradable_query_capacity",
        retryAfterMs: 0xffff_ffff,
        futurePressureProperty: { enabled: true },
      },
    });

    expect(parsed.serverPressure).toEqual({
      kind: "degradable_query_capacity",
      retryAfterMs: 0xffff_ffff,
    });
    expect(parsed.serverPressure).not.toHaveProperty("futurePressureProperty");
  });

  test("accepts transitions without pressure and ignores future properties", () => {
    const parsed = parseTransition({
      includeServerPressure: false,
      extra: { futureTransitionProperty: { enabled: true } },
    });

    expect(parsed).not.toHaveProperty("serverPressure");
    expect(parsed).toHaveProperty("futureTransitionProperty", {
      enabled: true,
    });
  });

  const malformedPressure: Array<[string, unknown]> = [
    ["null", null],
    ["a boolean", true],
    ["a string", "degradable_query_capacity"],
    ["an empty object", {}],
    ["an unknown kind", { kind: "normal", retryAfterMs: 1000 }],
    ["a missing delay", { kind: "degradable_query_capacity" }],
    [
      "a string delay",
      {
        kind: "degradable_query_capacity",
        retryAfterMs: "1000",
      },
    ],
    [
      "a boolean delay",
      {
        kind: "degradable_query_capacity",
        retryAfterMs: true,
      },
    ],
    ["zero", { kind: "degradable_query_capacity", retryAfterMs: 0 }],
    [
      "a negative delay",
      {
        kind: "degradable_query_capacity",
        retryAfterMs: -1,
      },
    ],
    [
      "a fractional delay",
      {
        kind: "degradable_query_capacity",
        retryAfterMs: 1.5,
      },
    ],
    [
      "an integer above the wire bound",
      {
        kind: "degradable_query_capacity",
        retryAfterMs: 0x1_0000_0000,
      },
    ],
    [
      "an unsafe integer",
      {
        kind: "degradable_query_capacity",
        retryAfterMs: Number.MAX_SAFE_INTEGER + 1,
      },
    ],
    ["NaN", { kind: "degradable_query_capacity", retryAfterMs: Number.NaN }],
    [
      "infinity",
      {
        kind: "degradable_query_capacity",
        retryAfterMs: Number.POSITIVE_INFINITY,
      },
    ],
  ];

  test.each(malformedPressure)(
    "rejects pressure with %s",
    (_name, pressure) => {
      expect(() => parseTransition({ serverPressure: pressure })).toThrow(
        "Invalid serverPressure in Transition",
      );
    },
  );
});
