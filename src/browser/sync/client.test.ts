import { describe, expect, test } from "vitest";
import { Long } from "../../vendor/long.js";
import { BaseConvexClient, type BaseConvexClientOptions } from "./client.js";
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
        });
        expect((await receive()).type).toBe("ModifyQuerySet");

        close();

        const reconnect = await receive();
        expect(reconnect).toMatchObject({
          type: "Connect",
          connectionCount: 1,
          queryWorkloadClass: "degradable",
        });
      } finally {
        await client.close();
      }
    });
  }, 10_000);

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
          });
          expect((await receive()).type).toBe("ModifyQuerySet");

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

          await expect(pressureReceived).resolves.toEqual({
            kind: "degradable_query_capacity",
            retryAfterMs: 250,
          });
        } finally {
          await client.close();
        }
      });
    },
  );
});
