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
  degradableQueryPressureVersion?: 1,
): ConnectMessage {
  return {
    type: "Connect",
    sessionId: "session",
    connectionCount: 0,
    lastCloseReason: null,
    clientTs: 123,
    ...(queryWorkloadClass === undefined ? {} : { queryWorkloadClass }),
    ...(degradableQueryPressureVersion === undefined
      ? {}
      : { degradableQueryPressureVersion }),
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

  test("serializes lifecycle capability and epoch retry", () => {
    expect(
      JSON.stringify(encodeClientMessage(connectMessage("degradable", 1))),
    ).toBe(
      '{"type":"Connect","sessionId":"session","connectionCount":0,"lastCloseReason":null,"clientTs":123,"queryWorkloadClass":"degradable","degradableQueryPressureVersion":1}',
    );
    expect(
      encodeClientMessage({ type: "RetryDegradableQueries", epoch: 7 }),
    ).toEqual({ type: "RetryDegradableQueries", epoch: 7 });
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

  test("decodes active and cleared pressure lifecycle", () => {
    expect(
      parseTransition({
        serverPressure: {
          kind: "degradable_query_capacity",
          state: "active",
          epoch: 0xffff_ffff,
          retryAfterMs: 0xffff_ffff,
          pendingQueryCount: 0xffff_ffff,
          futurePressureProperty: true,
        },
      }).serverPressure,
    ).toEqual({
      kind: "degradable_query_capacity",
      state: "active",
      epoch: 0xffff_ffff,
      retryAfterMs: 0xffff_ffff,
      pendingQueryCount: 0xffff_ffff,
    });
    expect(
      parseTransition({
        serverPressure: {
          kind: "degradable_query_capacity",
          state: "cleared",
          epoch: 7,
          pendingQueryCount: 0,
        },
      }).serverPressure,
    ).toEqual({
      kind: "degradable_query_capacity",
      state: "cleared",
      epoch: 7,
      pendingQueryCount: 0,
    });
  });

  test("rejects partial lifecycle shapes and invalid positive-u32 fields", () => {
    const active = {
      kind: "degradable_query_capacity",
      state: "active",
      epoch: 1,
      retryAfterMs: 1000,
      pendingQueryCount: 1,
    };
    const invalidPositiveU32 = [
      undefined,
      null,
      0,
      -1,
      1.5,
      0x1_0000_0000,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "1",
      true,
    ];
    for (const field of [
      "epoch",
      "retryAfterMs",
      "pendingQueryCount",
    ] as const) {
      for (const invalid of invalidPositiveU32) {
        expect(() =>
          parseTransition({
            serverPressure: { ...active, [field]: invalid },
          }),
        ).toThrow("Invalid serverPressure in Transition");
      }
    }

    for (const invalid of [
      { kind: "degradable_query_capacity", retryAfterMs: null },
      { kind: "degradable_query_capacity", retryAfterMs: 1000, epoch: 1 },
      { kind: "degradable_query_capacity", retryAfterMs: 1000, epoch: null },
      {
        kind: "degradable_query_capacity",
        retryAfterMs: 1000,
        pendingQueryCount: 1,
      },
      {
        kind: "degradable_query_capacity",
        state: "cleared",
        epoch: 1,
      },
      {
        kind: "degradable_query_capacity",
        state: "cleared",
        epoch: null,
        pendingQueryCount: 0,
      },
      {
        kind: "degradable_query_capacity",
        state: "cleared",
        epoch: 1,
        pendingQueryCount: null,
      },
      {
        kind: "degradable_query_capacity",
        state: "cleared",
        epoch: 1,
        pendingQueryCount: 0,
        retryAfterMs: null,
      },
      {
        kind: "degradable_query_capacity",
        state: "cleared",
        epoch: 0,
        pendingQueryCount: 0,
      },
      {
        kind: "degradable_query_capacity",
        state: "cleared",
        epoch: 0x1_0000_0000,
        pendingQueryCount: 0,
      },
    ]) {
      expect(() => parseTransition({ serverPressure: invalid })).toThrow(
        "Invalid serverPressure in Transition",
      );
    }
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
    [
      "a null state",
      {
        kind: "degradable_query_capacity",
        state: null,
        retryAfterMs: 1000,
      },
    ],
    [
      "an unknown state",
      {
        kind: "degradable_query_capacity",
        state: "future",
        epoch: 1,
        retryAfterMs: 1000,
        pendingQueryCount: 1,
      },
    ],
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
    [
      "an active zero epoch",
      {
        kind: "degradable_query_capacity",
        state: "active",
        epoch: 0,
        retryAfterMs: 1000,
        pendingQueryCount: 1,
      },
    ],
    [
      "an active zero pending count",
      {
        kind: "degradable_query_capacity",
        state: "active",
        epoch: 1,
        retryAfterMs: 1000,
        pendingQueryCount: 0,
      },
    ],
    [
      "a cleared nonzero pending count",
      {
        kind: "degradable_query_capacity",
        state: "cleared",
        epoch: 1,
        pendingQueryCount: 1,
      },
    ],
    [
      "a cleared retry delay",
      {
        kind: "degradable_query_capacity",
        state: "cleared",
        epoch: 1,
        pendingQueryCount: 0,
        retryAfterMs: 1000,
      },
    ],
    [
      "legacy lifecycle fields",
      {
        kind: "degradable_query_capacity",
        retryAfterMs: 1000,
        epoch: 1,
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
