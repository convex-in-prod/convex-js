import { describe, expect, test, vi } from "vitest";
import { Long } from "../../vendor/long.js";
import {
  BaseConvexClient,
  type BaseConvexClientInterface,
  type BaseConvexClientOptions,
} from "./client.js";
import { ConvexClient } from "../simple_client.js";
import { ConvexReactClient } from "../../react/client.js";
import {
  encodeServerMessage,
  nodeWebSocket,
  withInMemoryWebSocket,
} from "./client_node_test_helpers.js";
import type { ServerPressure, Transition } from "./protocol.js";

type ClientWrapper = {
  connectionState(): unknown;
  retryDegradableQueries(epoch: number): boolean;
  close(): Promise<void> | void;
};

const clientWrappers: Array<
  [string, (address: string, options: BaseConvexClientOptions) => ClientWrapper]
> = [
  ["ConvexClient", (address, options) => new ConvexClient(address, options)],
  [
    "ConvexReactClient",
    (address, options) => new ConvexReactClient(address, options),
  ],
];

test("React forwards the exact retry result from a supplied base client", async () => {
  const retryDegradableQueries = vi
    .fn((_epoch: number): boolean => false)
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(true);
  const baseClient = {
    addOnTransitionHandler: () => () => {},
    retryDegradableQueries,
    close: async () => {},
  } as unknown as BaseConvexClientInterface;
  const client = new ConvexReactClient("https://custom.example.com", {
    baseClient,
  });

  try {
    expect(client.retryDegradableQueries(3)).toBe(false);
    expect(client.retryDegradableQueries(3)).toBe(true);
    expect(retryDegradableQueries).toHaveBeenNthCalledWith(1, 3);
    expect(retryDegradableQueries).toHaveBeenNthCalledWith(2, 3);
  } finally {
    await client.close();
  }
});
describe("degradable BaseConvexClient", () => {
  test("serializes the workload class on the initial Connect and reconnect", async () => {
    await withInMemoryWebSocket(async ({ address, receive, close }) => {
      const client = new BaseConvexClient(address, () => {}, {
        webSocketConstructor: nodeWebSocket,
        logger: false,
        unsavedChangesWarning: false,
        skipConvexDeploymentUrlCheck: true,
        queryWorkloadClass: "degradable",
      });

      try {
        const initialConnect = await receive();
        expect(initialConnect).toMatchObject({
          type: "Connect",
          connectionCount: 0,
          queryWorkloadClass: "degradable",
          degradableQueryPressureVersion: 1,
        });
        expect((await receive()).type).toBe("ModifyQuerySet");

        close();

        const reconnect = await receive();
        expect(reconnect).toMatchObject({
          type: "Connect",
          connectionCount: 1,
          queryWorkloadClass: "degradable",
          degradableQueryPressureVersion: 1,
        });
      } finally {
        await client.close();
      }
    });
  }, 10_000);

  test("sends at most one retry for the connection's current active epoch", async () => {
    await withInMemoryWebSocket(async ({ address, receive, send, close }) => {
      const pressureWaiters: Array<(pressure: ServerPressure) => void> = [];
      const nextPressure = () =>
        new Promise<ServerPressure>((resolve) => {
          pressureWaiters.push(resolve);
        });
      const client = new BaseConvexClient(address, () => {}, {
        webSocketConstructor: nodeWebSocket,
        logger: false,
        unsavedChangesWarning: false,
        skipConvexDeploymentUrlCheck: true,
        queryWorkloadClass: "degradable",
        onServerPressure: (pressure) => pressureWaiters.shift()?.(pressure),
      });
      const sendPressure = (
        pressure: ServerPressure | undefined,
        endQuerySet = 0,
        endIdentity = 0,
      ) => {
        send({
          type: "Transition",
          startVersion: {
            querySet: 0,
            ts: Long.fromNumber(0),
            identity: 0,
          },
          endVersion: {
            querySet: endQuerySet,
            ts: Long.fromNumber(0),
            identity: endIdentity,
          },
          modifications: [],
          ...(pressure === undefined ? {} : { serverPressure: pressure }),
        });
      };

      try {
        expect(await receive()).toMatchObject({
          type: "Connect",
          degradableQueryPressureVersion: 1,
        });
        expect((await receive()).type).toBe("ModifyQuerySet");
        const activePressure = nextPressure();
        sendPressure({
          kind: "degradable_query_capacity",
          state: "active",
          epoch: 5,
          retryAfterMs: 250,
          pendingQueryCount: 2,
        });
        await expect(activePressure).resolves.toMatchObject({
          state: "active",
          epoch: 5,
        });

        let resolvePressureFreeTransition!: () => void;
        const pressureFreeTransition = new Promise<void>((resolve) => {
          resolvePressureFreeTransition = resolve;
        });
        const removeTransitionHandler = client.addOnTransitionHandler(() => {
          resolvePressureFreeTransition();
        });
        sendPressure(undefined);
        await pressureFreeTransition;
        removeTransitionHandler();

        const staleClear = nextPressure();
        sendPressure({
          kind: "degradable_query_capacity",
          state: "cleared",
          epoch: 4,
          pendingQueryCount: 0,
        });
        await staleClear;

        expect(client.retryDegradableQueries(4)).toBe(false);
        expect(client.retryDegradableQueries(5)).toBe(true);
        expect(await receive()).toEqual({
          type: "RetryDegradableQueries",
          epoch: 5,
        });
        expect(client.retryDegradableQueries(5)).toBe(false);

        const repeatedActive = nextPressure();
        sendPressure({
          kind: "degradable_query_capacity",
          state: "active",
          epoch: 5,
          retryAfterMs: 250,
          pendingQueryCount: 1,
        });
        await repeatedActive;
        expect(client.retryDegradableQueries(5)).toBe(false);

        for (const invalidEpoch of [0, -1, 1.5, Number.NaN, 0x1_0000_0000]) {
          expect(() => client.retryDegradableQueries(invalidEpoch)).toThrow(
            "positive unsigned 32-bit integer",
          );
        }

        const matchingClear = nextPressure();
        sendPressure({
          kind: "degradable_query_capacity",
          state: "cleared",
          epoch: 5,
          pendingQueryCount: 0,
        });
        await matchingClear;
        expect(client.retryDegradableQueries(5)).toBe(false);

        const nextEpoch = nextPressure();
        sendPressure({
          kind: "degradable_query_capacity",
          state: "active",
          epoch: 6,
          retryAfterMs: 250,
          pendingQueryCount: 1,
        });
        await nextEpoch;

        let resolveToken!: (token: string) => void;
        client.setAuth(
          () =>
            new Promise<string>((resolve) => {
              resolveToken = resolve;
            }),
          () => {},
        );
        expect(client.retryDegradableQueries(6)).toBe(false);
        resolveToken("test.header.signature");
        expect(await receive()).toMatchObject({
          type: "Authenticate",
          tokenType: "User",
        });
        expect(client.retryDegradableQueries(6)).toBe(true);
        expect(await receive()).toEqual({
          type: "RetryDegradableQueries",
          epoch: 6,
        });

        close();
        expect(await receive()).toMatchObject({
          type: "Connect",
          connectionCount: 1,
          degradableQueryPressureVersion: 1,
        });
        expect((await receive()).type).toBe("Authenticate");
        expect((await receive()).type).toBe("ModifyQuerySet");
        expect(client.retryDegradableQueries(5)).toBe(false);
        expect(client.retryDegradableQueries(6)).toBe(false);

        const replacementWorkerPressure = nextPressure();
        sendPressure(
          {
            kind: "degradable_query_capacity",
            state: "active",
            epoch: 5,
            retryAfterMs: 250,
            pendingQueryCount: 1,
          },
          1,
          1,
        );
        await replacementWorkerPressure;
        expect(client.retryDegradableQueries(5)).toBe(true);
        expect(await receive()).toEqual({
          type: "RetryDegradableQueries",
          epoch: 5,
        });
      } finally {
        await client.close();
      }
    });
  }, 10_000);

  test("invalidates the old epoch before a reconnect Connect send", async () => {
    let client!: BaseConvexClient;
    let retryDuringReconnect: boolean | undefined;
    class ReentrantConnectWebSocket extends nodeWebSocket {
      override send(
        data: string | ArrayBufferLike | Blob | ArrayBufferView,
      ): void {
        super.send(data);
        if (
          typeof data === "string" &&
          data.includes('"type":"Connect"') &&
          data.includes('"connectionCount":1')
        ) {
          retryDuringReconnect = client.retryDegradableQueries(5);
        }
      }
    }

    await withInMemoryWebSocket(async ({ address, receive, send, close }) => {
      let resolvePressure!: () => void;
      const pressureReceived = new Promise<void>((resolve) => {
        resolvePressure = resolve;
      });
      client = new BaseConvexClient(address, () => {}, {
        webSocketConstructor: ReentrantConnectWebSocket,
        logger: false,
        unsavedChangesWarning: false,
        skipConvexDeploymentUrlCheck: true,
        queryWorkloadClass: "degradable",
        onServerPressure: resolvePressure,
      });

      try {
        expect((await receive()).type).toBe("Connect");
        expect((await receive()).type).toBe("ModifyQuerySet");
        send({
          type: "Transition",
          startVersion: {
            querySet: 0,
            ts: Long.fromNumber(0),
            identity: 0,
          },
          endVersion: {
            querySet: 0,
            ts: Long.fromNumber(0),
            identity: 0,
          },
          modifications: [],
          serverPressure: {
            kind: "degradable_query_capacity",
            state: "active",
            epoch: 5,
            retryAfterMs: 250,
            pendingQueryCount: 1,
          },
        });
        await pressureReceived;

        close();
        expect(await receive()).toMatchObject({
          type: "Connect",
          connectionCount: 1,
        });
        expect(retryDuringReconnect).toBe(false);
        expect((await receive()).type).toBe("ModifyQuerySet");
      } finally {
        await client.close();
      }
    });
  }, 10_000);

  test("installs active pressure before transition listeners run", async () => {
    await withInMemoryWebSocket(async ({ address, receive, send }) => {
      let client!: BaseConvexClient;
      let resolveRetryResult!: (accepted: boolean) => void;
      const retryResult = new Promise<boolean>((resolve) => {
        resolveRetryResult = resolve;
      });
      client = new BaseConvexClient(
        address,
        () => resolveRetryResult(client.retryDegradableQueries(8)),
        {
          webSocketConstructor: nodeWebSocket,
          logger: false,
          unsavedChangesWarning: false,
          skipConvexDeploymentUrlCheck: true,
          queryWorkloadClass: "degradable",
        },
      );

      try {
        expect((await receive()).type).toBe("Connect");
        expect((await receive()).type).toBe("ModifyQuerySet");
        send({
          type: "Transition",
          startVersion: {
            querySet: 0,
            ts: Long.fromNumber(0),
            identity: 0,
          },
          endVersion: {
            querySet: 0,
            ts: Long.fromNumber(0),
            identity: 0,
          },
          modifications: [],
          serverPressure: {
            kind: "degradable_query_capacity",
            state: "active",
            epoch: 8,
            retryAfterMs: 250,
            pendingQueryCount: 1,
          },
        });

        await expect(retryResult).resolves.toBe(true);
        expect(await receive()).toEqual({
          type: "RetryDegradableQueries",
          epoch: 8,
        });
      } finally {
        await client.close();
      }
    });
  });

  test("does not accept a retry when WebSocket.send throws", async () => {
    let failRetrySend = true;
    class RetryFailingWebSocket extends nodeWebSocket {
      override send(
        data: string | ArrayBufferLike | Blob | ArrayBufferView,
      ): void {
        if (
          failRetrySend &&
          typeof data === "string" &&
          data.includes('"type":"RetryDegradableQueries"')
        ) {
          failRetrySend = false;
          throw new Error("test retry send failure");
        }
        super.send(data);
      }
    }

    await withInMemoryWebSocket(async ({ address, receive, send }) => {
      let resolvePressure!: () => void;
      const pressureReceived = new Promise<void>((resolve) => {
        resolvePressure = resolve;
      });
      const client = new BaseConvexClient(address, () => {}, {
        webSocketConstructor: RetryFailingWebSocket,
        logger: false,
        unsavedChangesWarning: false,
        skipConvexDeploymentUrlCheck: true,
        queryWorkloadClass: "degradable",
        onServerPressure: resolvePressure,
      });

      try {
        expect((await receive()).type).toBe("Connect");
        expect((await receive()).type).toBe("ModifyQuerySet");
        send({
          type: "Transition",
          startVersion: {
            querySet: 0,
            ts: Long.fromNumber(0),
            identity: 0,
          },
          endVersion: {
            querySet: 0,
            ts: Long.fromNumber(0),
            identity: 0,
          },
          modifications: [],
          serverPressure: {
            kind: "degradable_query_capacity",
            state: "active",
            epoch: 9,
            retryAfterMs: 250,
            pendingQueryCount: 1,
          },
        });
        await pressureReceived;

        expect(client.retryDegradableQueries(9)).toBe(false);
        expect(failRetrySend).toBe(false);
      } finally {
        await client.close();
      }
    });
  });

  test("applies a chunked pressure transition before invoking the callback", async () => {
    await withInMemoryWebSocket(async ({ address, receive, send }) => {
      const events: string[] = [];
      let resolvePressure!: (pressure: ServerPressure) => void;
      const pressureReceived = new Promise<ServerPressure>((resolve) => {
        resolvePressure = resolve;
      });
      const client = new BaseConvexClient(
        address,
        (updatedQueries) => {
          if (updatedQueries.length > 0) {
            events.push("transition");
          }
        },
        {
          webSocketConstructor: nodeWebSocket,
          logger: false,
          unsavedChangesWarning: false,
          skipConvexDeploymentUrlCheck: true,
          queryWorkloadClass: "degradable",
          onServerPressure: (pressure) => {
            events.push("pressure");
            resolvePressure(pressure);
          },
        },
      );
      const { queryToken } = client.subscribe("messages:list", {});

      try {
        expect((await receive()).type).toBe("Connect");
        const querySetMessage = await receive();
        if (querySetMessage.type !== "ModifyQuerySet") {
          throw new Error("Expected a ModifyQuerySet message");
        }
        const add = querySetMessage.modifications[0];
        if (add?.type !== "Add") {
          throw new Error("Expected an Add query modification");
        }

        const transition: Transition = {
          type: "Transition",
          startVersion: {
            querySet: 0,
            ts: Long.fromNumber(0),
            identity: 0,
          },
          endVersion: {
            querySet: 1,
            ts: Long.fromNumber(1),
            identity: 0,
          },
          modifications: [
            {
              type: "QueryUpdated",
              queryId: add.queryId,
              value: "current value",
              logLines: [],
              journal: null,
            },
          ],
          serverPressure: {
            kind: "degradable_query_capacity",
            retryAfterMs: 250,
          },
        };
        const encodedTransition = encodeServerMessage(transition);
        const splitAt = Math.floor(encodedTransition.length / 2);
        send({
          type: "TransitionChunk",
          chunk: encodedTransition.slice(0, splitAt),
          partNumber: 0,
          totalParts: 2,
          transitionId: "pressure-transition",
        });
        send({
          type: "TransitionChunk",
          chunk: encodedTransition.slice(splitAt),
          partNumber: 1,
          totalParts: 2,
          transitionId: "pressure-transition",
        });

        await expect(pressureReceived).resolves.toEqual({
          kind: "degradable_query_capacity",
          retryAfterMs: 250,
        });
        expect(events).toEqual(["transition", "pressure"]);
        expect(client.localQueryResultByToken(queryToken)).toBe(
          "current value",
        );

        const mutationPromise = client.mutation("messages:create", {});
        const mutation = await receive();
        expect(mutation.type).toBe("Mutation");
        if (mutation.type !== "Mutation") {
          throw new Error("Expected a Mutation request");
        }
        send({
          type: "MutationResponse",
          requestId: mutation.requestId,
          success: false,
          result: "mutation test response",
          logLines: [],
        });
        await expect(mutationPromise).rejects.toThrow("mutation test response");

        const actionPromise = client.action("messages:refresh", {});
        const action = await receive();
        expect(action.type).toBe("Action");
        if (action.type !== "Action") {
          throw new Error("Expected an Action request");
        }
        send({
          type: "ActionResponse",
          requestId: action.requestId,
          success: false,
          result: "action test response",
          logLines: [],
        });
        await expect(actionPromise).rejects.toThrow("action test response");
      } finally {
        await client.close();
      }
    });
  });

  test("isolates callback failures after direct transitions", async () => {
    await withInMemoryWebSocket(async ({ address, receive, send }) => {
      const events: string[] = [];
      let didUnsubscribe = false;
      let unsubscribe: (() => void) | undefined;
      let pressureCallCount = 0;
      let resolveFirstPressure!: () => void;
      let resolveSecondPressure!: () => void;
      const firstPressure = new Promise<void>((resolve) => {
        resolveFirstPressure = resolve;
      });
      const secondPressure = new Promise<void>((resolve) => {
        resolveSecondPressure = resolve;
      });
      let client!: BaseConvexClient;
      client = new BaseConvexClient(
        address,
        (updatedQueries) => {
          if (updatedQueries.length > 0 && !didUnsubscribe) {
            events.push("transition");
            didUnsubscribe = true;
            unsubscribe!();
          }
        },
        {
          webSocketConstructor: nodeWebSocket,
          logger: {
            logVerbose: () => {},
            log: () => {},
            warn: () => {},
            error: (message) => {
              if (message === "onServerPressure callback threw an error:") {
                events.push("pressure error logged");
              }
            },
          },
          unsavedChangesWarning: false,
          skipConvexDeploymentUrlCheck: true,
          queryWorkloadClass: "degradable",
          onServerPressure: () => {
            pressureCallCount += 1;
            events.push(`pressure ${pressureCallCount}`);
            events.push(
              `${client.connectionState().inflightMutations} inflight mutations`,
            );
            if (pressureCallCount === 1) {
              resolveFirstPressure();
              throw new Error("application pressure callback failed");
            }
            resolveSecondPressure();
          },
        },
      );
      const subscription = client.subscribe("messages:list", {});
      unsubscribe = subscription.unsubscribe;

      try {
        expect((await receive()).type).toBe("Connect");
        const querySetMessage = await receive();
        if (querySetMessage.type !== "ModifyQuerySet") {
          throw new Error("Expected a ModifyQuerySet message");
        }
        const add = querySetMessage.modifications[0];
        if (add?.type !== "Add") {
          throw new Error("Expected an Add query modification");
        }
        client.addOnTransitionHandler((transition) => {
          if (transition.reflectedMutations.length > 0) {
            events.push("mutation reflected");
          }
        });

        const mutationPromise = client.mutation("messages:create", {});
        const mutationMessage = await receive();
        if (mutationMessage.type !== "Mutation") {
          throw new Error("Expected a Mutation request");
        }
        send({
          type: "MutationResponse",
          requestId: mutationMessage.requestId,
          success: true,
          result: "created",
          ts: Long.fromNumber(1),
          logLines: [],
        });

        send({
          type: "Transition",
          startVersion: {
            querySet: 0,
            ts: Long.fromNumber(0),
            identity: 0,
          },
          endVersion: {
            querySet: 1,
            ts: Long.fromNumber(1),
            identity: 0,
          },
          modifications: [
            {
              type: "QueryUpdated",
              queryId: add.queryId,
              value: "current value",
              logLines: [],
              journal: null,
            },
          ],
          serverPressure: {
            kind: "degradable_query_capacity",
            retryAfterMs: 250,
          },
        });

        await firstPressure;
        expect(client.localQueryResultByToken(subscription.queryToken)).toBe(
          "current value",
        );
        expect(events).toEqual([
          "transition",
          "mutation reflected",
          "pressure 1",
          "0 inflight mutations",
          "pressure error logged",
        ]);
        await expect(mutationPromise).resolves.toBe("created");

        const removeMessage = await receive();
        expect(removeMessage).toMatchObject({
          type: "ModifyQuerySet",
          baseVersion: 1,
          newVersion: 2,
          modifications: [{ type: "Remove", queryId: add.queryId }],
        });

        send({
          type: "Transition",
          startVersion: {
            querySet: 1,
            ts: Long.fromNumber(1),
            identity: 0,
          },
          endVersion: {
            querySet: 2,
            ts: Long.fromNumber(2),
            identity: 0,
          },
          modifications: [{ type: "QueryRemoved", queryId: add.queryId }],
          serverPressure: {
            kind: "degradable_query_capacity",
            retryAfterMs: 500,
          },
        });

        await secondPressure;
        expect(events).toEqual([
          "transition",
          "mutation reflected",
          "pressure 1",
          "0 inflight mutations",
          "pressure error logged",
          "pressure 2",
          "0 inflight mutations",
        ]);
      } finally {
        await client.close();
      }
    });
  });

  test("logs asynchronous pressure callback rejections", async () => {
    await withInMemoryWebSocket(async ({ address, receive, send }) => {
      let resolveLogged!: () => void;
      const rejectionLogged = new Promise<void>((resolve) => {
        resolveLogged = resolve;
      });
      const client = new BaseConvexClient(address, () => {}, {
        webSocketConstructor: nodeWebSocket,
        logger: {
          logVerbose: () => {},
          log: () => {},
          warn: () => {},
          error: (message) => {
            if (message === "onServerPressure callback rejected:") {
              resolveLogged();
            }
          },
        },
        unsavedChangesWarning: false,
        skipConvexDeploymentUrlCheck: true,
        queryWorkloadClass: "degradable",
        onServerPressure: async () => {
          throw new Error("application pressure callback rejected");
        },
      });

      try {
        expect((await receive()).type).toBe("Connect");
        send({
          type: "Transition",
          startVersion: {
            querySet: 0,
            ts: Long.fromNumber(0),
            identity: 0,
          },
          endVersion: {
            querySet: 1,
            ts: Long.fromNumber(1),
            identity: 0,
          },
          modifications: [],
          serverPressure: {
            kind: "degradable_query_capacity",
            retryAfterMs: 250,
          },
        });

        await rejectionLogged;
      } finally {
        await client.close();
      }
    });
  });

  test.each(clientWrappers)(
    "%s passes workload and pressure options to its internal base client",
    async (_name, createClient) => {
      await withInMemoryWebSocket(async ({ address, receive, send }) => {
        let resolvePressure!: (pressure: ServerPressure) => void;
        const pressureReceived = new Promise<ServerPressure>((resolve) => {
          resolvePressure = resolve;
        });
        const client = createClient(address, {
          webSocketConstructor: nodeWebSocket,
          logger: false,
          unsavedChangesWarning: false,
          skipConvexDeploymentUrlCheck: true,
          queryWorkloadClass: "degradable",
          onServerPressure: resolvePressure,
        });
        client.connectionState();

        try {
          expect(await receive()).toMatchObject({
            type: "Connect",
            queryWorkloadClass: "degradable",
            degradableQueryPressureVersion: 1,
          });
          expect((await receive()).type).toBe("ModifyQuerySet");
          expect(client.retryDegradableQueries(7)).toBe(false);

          send({
            type: "Transition",
            startVersion: {
              querySet: 0,
              ts: Long.fromNumber(0),
              identity: 0,
            },
            endVersion: {
              querySet: 1,
              ts: Long.fromNumber(1),
              identity: 0,
            },
            modifications: [],
            serverPressure: {
              kind: "degradable_query_capacity",
              state: "active",
              epoch: 7,
              retryAfterMs: 250,
              pendingQueryCount: 1,
            },
          });

          await expect(pressureReceived).resolves.toEqual({
            kind: "degradable_query_capacity",
            state: "active",
            epoch: 7,
            retryAfterMs: 250,
            pendingQueryCount: 1,
          });
          expect(client.retryDegradableQueries(7)).toBe(true);
          expect(await receive()).toEqual({
            type: "RetryDegradableQueries",
            epoch: 7,
          });
        } finally {
          await client.close();
        }
      });
    },
  );
});
