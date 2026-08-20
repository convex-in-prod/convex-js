import { describe, expect, test, vi } from "vitest";
import { makeFunctionReference } from "../server/api.js";
import { ConvexHttpClient, ConvexHttpError } from "./index.js";

const mutation = makeFunctionReference<"mutation", { value: string }, string>(
  "test:mutation",
);

const rejectedBeforeExecutionCodes = [
  "ExpiredInQueue",
  "WorkerOverloaded",
  "IsolateNotClean",
  "InitialPermitTimeoutError",
  "ExecuteFullError",
] as const;

describe("ConvexHttpClient HTTP errors", () => {
  test("preserves a completed JSON failure as a typed HTTP error", async () => {
    const responseBody = {
      code: "ExpiredInQueue",
      message: "Request expired while waiting for execution admission",
    };
    const localFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(responseBody), {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
    const client = new ConvexHttpClient("https://http-error.convex.cloud", {
      fetch: localFetch,
    });

    const failure = await client
      .mutation(mutation, { value: "test" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConvexHttpError);
    expect(failure).toMatchObject({
      name: "ConvexHttpError",
      status: 503,
      responseText: JSON.stringify(responseBody),
      responseJson: responseBody,
      executionStatus: "rejected_before_execution",
    });
  });

  test.each(rejectedBeforeExecutionCodes)(
    "classifies completed %s as rejected before execution",
    async (code) => {
      const localFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ code, message: "Admission rejected" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      );
      const client = new ConvexHttpClient(
        "https://execution-rejection.convex.cloud",
        { fetch: localFetch },
      );

      const failure = await client
        .mutation(mutation, { value: "test" })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({
        executionStatus: "rejected_before_execution",
      });
    },
  );

  test("does not classify an unknown completed 503 code", async () => {
    const localFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: "FutureAdmissionFailure" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ConvexHttpClient(
      "https://unknown-http-error.convex.cloud",
      { fetch: localFetch },
    );

    const failure = await client
      .mutation(mutation, { value: "test" })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ executionStatus: undefined });
  });

  test("does not classify a known code with a different status", async () => {
    const localFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: "ExpiredInQueue" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ConvexHttpClient(
      "https://wrong-status-http-error.convex.cloud",
      { fetch: localFetch },
    );

    const failure = await client
      .mutation(mutation, { value: "test" })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ executionStatus: undefined });
  });

  test("does not invent structured data for a malformed JSON failure", async () => {
    const localFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{not-json", {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ConvexHttpClient(
      "https://malformed-error.convex.cloud",
      {
        fetch: localFetch,
      },
    );

    const failure = await client
      .mutation(mutation, { value: "test" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConvexHttpError);
    expect(failure).toMatchObject({
      status: 503,
      responseText: "{not-json",
      responseJson: undefined,
      executionStatus: undefined,
    });
  });
});
