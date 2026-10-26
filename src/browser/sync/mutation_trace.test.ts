import { describe, expect, test, vi } from "vitest";
import { BaseConvexClient, type MutationTraceEvent } from "./client.js";
import { Long } from "../../vendor/long.js";
import {
  nodeWebSocket,
  encodeServerMessage,
  withInMemoryWebSocket,
} from "./client_node_test_helpers.js";

const options = {
  webSocketConstructor: nodeWebSocket,
  logger: false,
  unsavedChangesWarning: false,
  skipConvexDeploymentUrlCheck: true,
};

const transition = {
  type: "Transition" as const,
  startVersion: { querySet: 0, identity: 0, ts: Long.fromNumber(0) },
  endVersion: { querySet: 0, identity: 0, ts: Long.fromNumber(10) },
  modifications: [],
};

describe("payload-free mutation tracing", () => {
  test("waits for a covering transition and observes application before the promise continuation", async () => {
    await withInMemoryWebSocket(async ({ address, receive, send }) => {
      const events: MutationTraceEvent[] = [];
      let listenerFinishedAt = 0;
      const client = new BaseConvexClient(address, () => {}, {
        ...options,
        onMutationTrace: (event) => {
          events.push(event);
        },
      });
      client.addOnTransitionHandler(() => {
        listenerFinishedAt = performance.now();
      });
      try {
        await receive();
        await receive();
        const result = client.mutation("messages:create", {
          text: "private argument",
        });
        const request = await receive();
        if (request.type !== "Mutation") throw new Error("Expected mutation");
        send({
          type: "MutationResponse",
          requestId: request.requestId,
          success: true,
          ts: Long.fromNumber(10),
          result: "private result",
          logLines: ["private log"],
        });
        await vi.waitFor(() =>
          expect(events.at(-1)?.phase).toBe("response_received"),
        );
        expect(events.map((event) => event.phase)).toEqual([
          "enqueued",
          "send_attempt",
          "response_received",
        ]);
        send(transition);
        await expect(result).resolves.toBe("private result");
        expect(events.map((event) => event.phase)).toEqual([
          "enqueued",
          "send_attempt",
          "response_received",
          "transition_received",
          "transition_applied",
          "request_promise_resolved",
        ]);
        const times = events.flatMap((event) =>
          "monotonicTime" in event ? [event.monotonicTime] : [],
        );
        expect(times).toEqual([...times].sort((a, b) => a - b));
        expect(times[3]).toBeLessThanOrEqual(listenerFinishedAt);
        expect(times[4]).toBeGreaterThanOrEqual(listenerFinishedAt);
        expect(JSON.stringify(events)).not.toContain("private");
      } finally {
        await client.close();
      }
      expect(events.at(-1)?.phase).toBe("client_closed");
    });
  });

  test("retains one request identity through queued send and response replay after reconnect", async () => {
    await withInMemoryWebSocket(async ({ address, receive, send, close }) => {
      const events: MutationTraceEvent[] = [];
      const client = new BaseConvexClient(address, () => {}, {
        ...options,
        onMutationTrace: (event) => {
          events.push(event);
        },
      });
      try {
        const result = client.mutation("messages:create", {});
        expect(events[1]).toMatchObject({
          phase: "send_attempt",
          mightBeSent: false,
        });
        await receive();
        await receive();
        const request = await receive();
        if (request.type !== "Mutation") throw new Error("Expected mutation");
        send({
          type: "MutationResponse",
          requestId: request.requestId,
          success: true,
          ts: Long.fromNumber(10),
          result: null,
          logLines: [],
        });
        await vi.waitFor(() =>
          expect(events.at(-1)?.phase).toBe("response_received"),
        );
        close();
        await receive();
        await receive();
        expect(await receive()).toMatchObject({
          type: "Mutation",
          requestId: request.requestId,
        });
        send({
          type: "MutationResponse",
          requestId: request.requestId,
          success: true,
          ts: Long.fromNumber(10),
          result: null,
          logLines: [],
        });
        send(transition);
        await expect(result).resolves.toBeNull();
        expect(
          events.filter((event) => event.phase === "enqueued"),
        ).toHaveLength(1);
        expect(
          events.filter((event) => event.phase === "send_attempt"),
        ).toHaveLength(3);
        expect(
          events.filter((event) => event.phase === "request_promise_resolved"),
        ).toHaveLength(1);
        expect(
          new Set(
            events
              .filter((event) => "requestId" in event)
              .map((event) => event.requestId),
          ),
        ).toEqual(new Set([request.requestId]));
      } finally {
        await client.close();
      }
    });
  }, 10_000);

  test("reports failures without waiting for a transition or copying error data", async () => {
    await withInMemoryWebSocket(async ({ address, receive, send }) => {
      const events: MutationTraceEvent[] = [];
      const client = new BaseConvexClient(address, () => {}, {
        ...options,
        onMutationTrace: (event) => {
          events.push(event);
        },
      });
      try {
        await receive();
        await receive();
        const result = client.mutation("messages:create", {});
        const rejection = expect(result).rejects.toThrow("private failure");
        const request = await receive();
        if (request.type !== "Mutation") throw new Error("Expected mutation");
        send({
          type: "MutationResponse",
          requestId: request.requestId,
          success: false,
          result: "private failure",
          errorData: { secret: "private data" },
          logLines: [],
        });
        await rejection;
        expect(events.map((event) => event.phase)).toEqual([
          "enqueued",
          "send_attempt",
          "response_received",
          "request_promise_resolved",
        ]);
        expect(events.at(-1)).toMatchObject({ success: false });
        expect(JSON.stringify(events)).not.toContain("private");
      } finally {
        await client.close();
      }
    });
  });

  test.each(["throw", "reject"] as const)(
    "observer %s cannot change mutation completion",
    async (mode) => {
      await withInMemoryWebSocket(async ({ address, receive, send }) => {
        const client = new BaseConvexClient(address, () => {}, {
          ...options,
          logger: {
            logVerbose: () => {},
            log: () => {},
            warn: () => {
              throw new Error("custom logger failed");
            },
            error: () => {
              throw new Error("custom logger failed");
            },
          },
          onMutationTrace: () => {
            if (mode === "throw") throw new Error("private observer detail");
            return Promise.reject(new Error("private observer detail"));
          },
        });
        try {
          await receive();
          await receive();
          const result = client.mutation("messages:create", {});
          const request = await receive();
          if (request.type !== "Mutation") throw new Error("Expected mutation");
          send({
            type: "MutationResponse",
            requestId: request.requestId,
            success: true,
            ts: Long.fromNumber(10),
            result: "created",
            logLines: [],
          });
          send(transition);
          await expect(result).resolves.toBe("created");
          const nextResult = client.mutation("messages:create", {});
          const nextRequest = await receive();
          if (nextRequest.type !== "Mutation")
            throw new Error("Expected next mutation");
          send({
            type: "MutationResponse",
            requestId: nextRequest.requestId,
            success: true,
            ts: Long.fromNumber(20),
            result: "created again",
            logLines: [],
          });
          send({
            ...transition,
            startVersion: transition.endVersion,
            endVersion: { ...transition.endVersion, ts: Long.fromNumber(20) },
          });
          await expect(nextResult).resolves.toBe("created again");
        } finally {
          await client.close();
        }
      });
    },
  );
  test.each([false, true])(
    "missing diagnostic clock cannot affect mutation or close (observer: %s)",
    async (observe) => {
      await withInMemoryWebSocket(async ({ address, receive, send }) => {
        const events: MutationTraceEvent[] = [];
        const client = new BaseConvexClient(address, () => {}, {
          ...options,
          ...(observe
            ? {
                onMutationTrace: (event: MutationTraceEvent) => {
                  events.push(event);
                },
              }
            : {}),
        });
        try {
          await receive();
          await receive();
          let result: Promise<unknown>;
          vi.stubGlobal("performance", undefined);
          try {
            result = client.mutation("messages:create", {});
          } finally {
            vi.unstubAllGlobals();
          }
          const request = await receive();
          if (request.type !== "Mutation") throw new Error("Expected mutation");
          send({
            type: "MutationResponse",
            requestId: request.requestId,
            success: true,
            ts: Long.fromNumber(10),
            result: "created",
            logLines: [],
          });
          send(transition);
          await expect(result).resolves.toBe("created");
          expect(events).toEqual(
            observe ? [{ phase: "tracing_disabled" }] : [],
          );
        } finally {
          vi.stubGlobal("performance", undefined);
          try {
            await client.close();
          } finally {
            vi.unstubAllGlobals();
          }
        }
      });
    },
  );

  test("retry observations share logical identity and distinguish a retrying result", async () => {
    await withInMemoryWebSocket(async ({ address, receive, send }) => {
      const events: MutationTraceEvent[] = [];
      const client = new BaseConvexClient(address, () => {}, {
        ...options,
        onMutationTrace: (event) => {
          events.push(event);
        },
      });
      try {
        await receive();
        await receive();
        const result = client.mutation(
          "messages:create",
          {},
          { writeConflictRetryDelayMs: 1 },
        );
        const first = await receive();
        if (first.type !== "Mutation") throw new Error("Expected mutation");
        const unrelated = client.action("messages:action", {});
        const action = await receive();
        if (action.type !== "Action")
          throw new Error("Expected interleaved action");
        send({
          type: "ActionResponse",
          requestId: action.requestId,
          success: true,
          result: null,
          logLines: [],
        });
        send({
          type: "MutationResponse",
          requestId: first.requestId,
          success: false,
          result: "OptimisticConcurrencyControlFailure",
          logLines: [],
        });
        const second = await receive();
        if (second.type !== "Mutation") throw new Error("Expected retry");
        expect(second.requestId).toBe(first.requestId + 2);
        send({
          type: "MutationResponse",
          requestId: second.requestId,
          success: true,
          ts: Long.fromNumber(10),
          result: "created",
          logLines: [],
        });
        send(transition);
        await expect(result).resolves.toBe("created");
        await expect(unrelated).resolves.toBeNull();
        expect(
          events.filter((event) => event.phase === "enqueued"),
        ).toMatchObject([
          {
            requestId: first.requestId,
            mutationId: first.requestId,
            attempt: 1,
          },
          {
            requestId: second.requestId,
            mutationId: first.requestId,
            attempt: 2,
          },
        ]);
        expect(
          events.filter((event) => event.phase === "request_promise_resolved"),
        ).toMatchObject([
          { requestId: first.requestId, success: false, willRetry: true },
          { requestId: second.requestId, success: true, willRetry: false },
        ]);
      } finally {
        await client.close();
      }
    });
  });

  test("reentrant observers cannot reverse initial sends or run before pressure application", async () => {
    await withInMemoryWebSocket(async ({ address, receive, send }) => {
      const order: string[] = [];
      let nested: Promise<unknown> | undefined;
      const client = new BaseConvexClient(
        address,
        () => order.push("listener"),
        {
          ...options,
          onServerPressure: () => {
            order.push("pressure");
          },
          onMutationTrace: (event) => {
            if (
              event.phase === "enqueued" &&
              event.functionName === "messages:first"
            ) {
              nested = client.mutation("messages:nested", {});
            }
            if (event.phase === "transition_received") {
              order.push("trace");
              expect(client.connectionState().inflightMutations).toBe(0);
              expect(client.localQueryResult("messages:list", {})).toBe(
                "updated",
              );
            }
          },
        },
      );
      client.subscribe("messages:list", {});
      try {
        await receive();
        const querySet = await receive();
        if (
          querySet.type !== "ModifyQuerySet" ||
          querySet.modifications[0]?.type !== "Add"
        ) {
          throw new Error("Expected query subscription");
        }
        const first = client.mutation("messages:first", {});
        const firstRequest = await receive();
        const nestedRequest = await receive();
        expect(firstRequest).toMatchObject({
          type: "Mutation",
          udfPath: "messages:first",
        });
        expect(nestedRequest).toMatchObject({
          type: "Mutation",
          udfPath: "messages:nested",
        });
        if (
          firstRequest.type !== "Mutation" ||
          nestedRequest.type !== "Mutation"
        )
          throw new Error("Expected mutations");
        for (const request of [firstRequest, nestedRequest]) {
          send({
            type: "MutationResponse",
            requestId: request.requestId,
            success: true,
            ts: Long.fromNumber(10),
            result: request.udfPath,
            logLines: [],
          });
        }
        send({
          ...transition,
          endVersion: { ...transition.endVersion, querySet: 1 },
          modifications: [
            {
              type: "QueryUpdated",
              queryId: querySet.modifications[0].queryId,
              value: "updated",
              logLines: [],
              journal: null,
            },
          ],
          serverPressure: {
            kind: "degradable_query_capacity",
            retryAfterMs: 250,
          },
        });
        expect(await Promise.all([first, nested])).toEqual([
          "messages:first",
          "messages:nested",
        ]);
        expect(order).toEqual(["listener", "pressure", "trace", "trace"]);
      } finally {
        await client.close();
      }
    });
  });

  test("auth pause queues a mutation and resume retains the same request", async () => {
    await withInMemoryWebSocket(async ({ address, receive, send }) => {
      const events: MutationTraceEvent[] = [];
      const client = new BaseConvexClient(address, () => {}, {
        ...options,
        onMutationTrace: (event) => {
          events.push(event);
        },
      });
      try {
        await receive();
        await receive();
        let releaseToken!: (token: string | null) => void;
        const token = new Promise<string | null>((resolve) => {
          releaseToken = resolve;
        });
        client.setAuth(
          () => token,
          () => {},
        );
        const result = client.mutation("messages:create", {});
        expect(events.at(-1)).toMatchObject({
          phase: "send_attempt",
          mightBeSent: false,
          reason: "initial",
        });
        releaseToken(null);
        const request = await receive();
        if (request.type !== "Mutation")
          throw new Error("Expected resumed mutation");
        send({
          type: "MutationResponse",
          requestId: request.requestId,
          success: true,
          ts: Long.fromNumber(10),
          result: "created",
          logLines: [],
        });
        send(transition);
        await expect(result).resolves.toBe("created");
        expect(
          events.filter((event) => event.phase === "send_attempt"),
        ).toMatchObject([
          {
            requestId: request.requestId,
            reason: "initial",
            mightBeSent: false,
          },
          { requestId: request.requestId, reason: "resume", mightBeSent: true },
        ]);
      } finally {
        await client.close();
      }
    });
  });

  test("a transition before the response does not invent settlement or covering markers", async () => {
    await withInMemoryWebSocket(async ({ address, receive, send }) => {
      const events: MutationTraceEvent[] = [];
      const client = new BaseConvexClient(address, () => {}, {
        ...options,
        onMutationTrace: (event) => {
          events.push(event);
        },
      });
      try {
        await receive();
        await receive();
        const result = client.mutation("messages:create", {});
        const request = await receive();
        if (request.type !== "Mutation") throw new Error("Expected mutation");
        send(transition);
        send({
          type: "MutationResponse",
          requestId: request.requestId,
          success: true,
          ts: Long.fromNumber(10),
          result: "created",
          logLines: [],
        });
        await vi.waitFor(() =>
          expect(events.at(-1)?.phase).toBe("response_received"),
        );
        expect(client.connectionState().inflightMutations).toBe(1);
        expect(
          events.some((event) => event.phase === "transition_received"),
        ).toBe(false);
        send({
          ...transition,
          startVersion: transition.endVersion,
          endVersion: { ...transition.endVersion, ts: Long.fromNumber(20) },
        });
        await expect(result).resolves.toBe("created");
        expect(
          events.filter((event) => event.phase === "transition_received"),
        ).toHaveLength(1);
      } finally {
        await client.close();
      }
    });
  });

  test("clock failure after enqueue emits untimed cleanup while the mutation still completes", async () => {
    await withInMemoryWebSocket(async ({ address, receive, send }) => {
      const events: MutationTraceEvent[] = [];
      const client = new BaseConvexClient(address, () => {}, {
        ...options,
        onMutationTrace: (event) => {
          events.push(event);
        },
      });
      const clock = vi.spyOn(performance, "now");
      try {
        await receive();
        await receive();
        const result = client.mutation("messages:create", {});
        const request = await receive();
        if (request.type !== "Mutation") throw new Error("Expected mutation");
        clock.mockReturnValue(Number.NaN);
        send({
          type: "MutationResponse",
          requestId: request.requestId,
          success: true,
          ts: Long.fromNumber(10),
          result: "created",
          logLines: [],
        });
        send(transition);
        await expect(result).resolves.toBe("created");
        expect(events.map((event) => event.phase)).toEqual([
          "enqueued",
          "send_attempt",
          "tracing_disabled",
        ]);
      } finally {
        clock.mockRestore();
        await client.close();
      }
    });
  });

  test("a failing retry enqueue ends logical observation without replacing the original error", async () => {
    await withInMemoryWebSocket(async ({ address, receive, send }) => {
      const events: MutationTraceEvent[] = [];
      const failure = new Error("private optimistic failure");
      let attempts = 0;
      const client = new BaseConvexClient(address, () => {}, {
        ...options,
        onMutationTrace: (event) => {
          events.push(event);
        },
      });
      try {
        await receive();
        await receive();
        const result = client.mutation(
          "messages:create",
          {},
          {
            writeConflictRetryDelayMs: 1,
            optimisticUpdate: () => {
              if (++attempts > 1) throw failure;
            },
          },
        );
        const rejection = expect(result).rejects.toBe(failure);
        const request = await receive();
        if (request.type !== "Mutation") throw new Error("Expected mutation");
        send({
          type: "MutationResponse",
          requestId: request.requestId,
          success: false,
          result: "OptimisticConcurrencyControlFailure",
          logLines: [],
        });
        await rejection;
        expect(events.at(-1)).toMatchObject({
          phase: "mutation_aborted",
          mutationId: request.requestId,
        });
        expect(JSON.stringify(events)).not.toContain("private");
        expect(client.connectionState().inflightMutations).toBe(0);
      } finally {
        await client.close();
      }
    });
  });

  test("close observations are terminal even when the observer reenters close", async () => {
    await withInMemoryWebSocket(async ({ address, receive }) => {
      const events: MutationTraceEvent[] = [];
      let reenteredClose: Promise<void> | undefined;
      const client = new BaseConvexClient(address, () => {}, {
        ...options,
        onMutationTrace: (event) => {
          events.push(event);
          if (event.phase === "client_closed") reenteredClose = client.close();
        },
      });
      await receive();
      await receive();
      void client.mutation("messages:create", {});
      await receive();
      await client.close();
      await reenteredClose;
      expect(
        events.filter((event) => event.phase === "client_closed"),
      ).toHaveLength(1);
      expect(client.connectionState().isWebSocketConnected).toBe(false);
    });
  });

  test.each([true, false])(
    "listener errors preserve request settlement and receipt evidence (success: %s)",
    async (success) => {
      await withInMemoryWebSocket(async ({ address, receive, send }) => {
        let transport: WebSocket | undefined;
        class CapturedWebSocket extends nodeWebSocket {
          constructor(...args: ConstructorParameters<typeof nodeWebSocket>) {
            super(...args);
            transport = this;
          }
        }
        const failure = new Error("existing listener failure");
        const events: MutationTraceEvent[] = [];
        const client = new BaseConvexClient(
          address,
          () => {
            throw failure;
          },
          {
            ...options,
            webSocketConstructor: CapturedWebSocket,
            onMutationTrace: (event) => {
              events.push(event);
            },
          },
        );
        try {
          await receive();
          await receive();
          const result = client.mutation("messages:create", {});
          const request = await receive();
          if (request.type !== "Mutation") throw new Error("Expected mutation");
          if (success) {
            send({
              type: "MutationResponse",
              requestId: request.requestId,
              success: true,
              ts: Long.fromNumber(10),
              result: "created",
              logLines: [],
            });
            await vi.waitFor(() =>
              expect(events.at(-1)?.phase).toBe("response_received"),
            );
          }
          const settlement = success
            ? expect(result).resolves.toBe("created")
            : expect(result).rejects.toThrow("application failed");
          if (transport === undefined || transport.onmessage === null)
            throw new Error("Expected active transport");
          const socket = transport;
          const onMessage = transport.onmessage;
          // Invoke the installed receive handler directly only to capture its existing
          // thrown listener error; request/transition processing remains real SDK code.
          expect(() =>
            onMessage.call(
              socket,
              new MessageEvent("message", {
                data: encodeServerMessage(
                  success
                    ? transition
                    : {
                        type: "MutationResponse",
                        requestId: request.requestId,
                        success: false,
                        result: "application failed",
                        logLines: [],
                      },
                ),
              }),
            ),
          ).toThrow(failure);
          await settlement;
          expect(client.connectionState().inflightMutations).toBe(0);
          expect(events.map((event) => event.phase)).toEqual([
            "enqueued",
            "send_attempt",
            "response_received",
            "request_promise_resolved",
          ]);
        } finally {
          await client.close();
        }
      });
    },
  );

  test("an absent observer performs no diagnostic clock reads", async () => {
    await withInMemoryWebSocket(async ({ address, receive, send }) => {
      const client = new BaseConvexClient(address, () => {}, options);
      try {
        await receive();
        await receive();
        const clock = vi.spyOn(performance, "now");
        const result = client.mutation("messages:create", {});
        try {
          expect(clock).not.toHaveBeenCalled();
        } finally {
          clock.mockRestore();
        }
        const request = await receive();
        if (request.type !== "Mutation") throw new Error("Expected mutation");
        send({
          type: "MutationResponse",
          requestId: request.requestId,
          success: true,
          ts: Long.fromNumber(10),
          result: null,
          logLines: [],
        });
        send(transition);
        await expect(result).resolves.toBeNull();
      } finally {
        await client.close();
      }
    });
  });

  test("fatal transport termination ends observation without settling the pending request", async () => {
    await withInMemoryWebSocket(async ({ address, receive }) => {
      let transport: WebSocket | undefined;
      class CapturedWebSocket extends nodeWebSocket {
        constructor(...args: ConstructorParameters<typeof nodeWebSocket>) {
          super(...args);
          transport = this;
        }
      }
      const events: MutationTraceEvent[] = [];
      const client = new BaseConvexClient(address, () => {}, {
        ...options,
        webSocketConstructor: CapturedWebSocket,
        onMutationTrace: (event) => {
          events.push(event);
        },
      });
      try {
        await receive();
        await receive();
        let settled = false;
        void client.mutation("messages:create", {}).then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await receive();
        if (transport === undefined || transport.onmessage === null)
          throw new Error("Expected active transport");
        const socket = transport;
        const onMessage = transport.onmessage;
        expect(() =>
          onMessage.call(
            socket,
            new MessageEvent("message", {
              data: encodeServerMessage({
                type: "FatalError",
                error: "private fatal detail",
              }),
            }),
          ),
        ).toThrow("private fatal detail");
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(client.connectionState()).toMatchObject({
          isWebSocketConnected: false,
          inflightMutations: 1,
        });
        expect(events.map((event) => event.phase)).toEqual([
          "enqueued",
          "send_attempt",
          "client_closed",
        ]);
        expect(JSON.stringify(events)).not.toContain("private");
      } finally {
        await client.close();
      }
      expect(
        events.filter((event) => event.phase === "client_closed"),
      ).toHaveLength(1);
    });
  });
});
