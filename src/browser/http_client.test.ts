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

describe("ConvexHttpClient mutation retry evidence", () => {
  const occ = {
    code: "OptimisticConcurrencyControlFailure",
    message:
      "Data read or written in this mutation changed while it was being run.",
  };

  test.each([0, 2])(
    "bounds definitive OCC retries to %s",
    async (maxWriteConflictRetries) => {
      const localFetch = vi.fn<typeof fetch>().mockImplementation(
        async () =>
          new Response(JSON.stringify(occ), {
            status: 503,
            headers: { "content-type": "application/json; charset=utf-8" },
          }),
      );
      const client = new ConvexHttpClient("https://occ.convex.cloud", {
        fetch: localFetch,
      });

      const failure = await client
        .mutation(
          mutation,
          { value: "test" },
          {
            maxWriteConflictRetries,
            writeConflictRetryDelayMs: 0,
          },
        )
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ConvexHttpError);
      expect(failure).toMatchObject({ status: 503, responseJson: occ });
      expect(localFetch).toHaveBeenCalledTimes(1 + maxWriteConflictRetries);
    },
  );

  test.each([
    ["wrong status", 500, JSON.stringify(occ), "application/json"],
    [
      "UDF error",
      200,
      JSON.stringify({ status: "error", errorMessage: occ.code }),
      "application/json",
    ],
    [
      "legacy UDF error",
      560,
      JSON.stringify({ status: "error", errorMessage: occ.code }),
      "application/json",
    ],
    [
      "unrelated code",
      503,
      JSON.stringify({ code: "OtherError", message: occ.code }),
      "application/json",
    ],
    [
      "missing message",
      503,
      JSON.stringify({ code: occ.code }),
      "application/json",
    ],
    [
      "non-string message",
      503,
      JSON.stringify({ code: occ.code, message: null }),
      "application/json",
    ],
    [
      "truncated JSON",
      503,
      JSON.stringify(occ).slice(0, -1),
      "application/json",
    ],
    ["absent body", 503, "", "application/json"],
    ["non-JSON content type", 503, JSON.stringify(occ), "text/plain"],
  ] as const)(
    "does not replay %s",
    async (_name, status, body, contentType) => {
      const localFetch = vi
        .fn<typeof fetch>()
        .mockImplementation(
          async () =>
            new Response(body, {
              status,
              headers: { "content-type": contentType },
            }),
        );
      const client = new ConvexHttpClient("https://non-occ.convex.cloud", {
        fetch: localFetch,
      });

      const failure = await client
        .mutation(
          mutation,
          { value: "test" },
          {
            writeConflictRetryDelayMs: 0,
          },
        )
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        message: status === 200 || status === 560 ? occ.code : body,
      });
      expect(localFetch).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    new TypeError(`Response lost after submission: ${occ.code}`),
    new DOMException(occ.code, "TimeoutError"),
    new Error("Unrelated transport failure"),
  ])("preserves transport failure without replay: %s", async (failure) => {
    const localFetch = vi.fn<typeof fetch>().mockRejectedValue(failure);
    const client = new ConvexHttpClient("https://transport.convex.cloud", {
      fetch: localFetch,
    });

    await expect(
      client.mutation(
        mutation,
        { value: "test" },
        {
          writeConflictRetryDelayMs: 0,
        },
      ),
    ).rejects.toBe(failure);
    expect(localFetch).toHaveBeenCalledTimes(1);
  });

  test("requires the response stream to complete even after valid OCC JSON arrives", async () => {
    const failure = new TypeError(`Response stream interrupted: ${occ.code}`);
    const localFetch = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(JSON.stringify(occ)));
            },
            pull(controller) {
              controller.error(failure);
            },
          }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const client = new ConvexHttpClient("https://incomplete.convex.cloud", {
      fetch: localFetch,
    });

    await expect(
      client.mutation(
        mutation,
        { value: "test" },
        {
          writeConflictRetryDelayMs: 0,
        },
      ),
    ).rejects.toBe(failure);
    expect(localFetch).toHaveBeenCalledTimes(1);
  });

  test("retains the default OCC delay and queue order while an independent call completes", async () => {
    vi.useFakeTimers();
    try {
      const requests: unknown[] = [];
      const localFetch = vi
        .fn<typeof fetch>()
        .mockImplementation(async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify(
              requests.length === 1 ? occ : { status: "success", value: "ok" },
            ),
            {
              status: requests.length === 1 ? 503 : 200,
              headers: { "content-type": "application/json" },
            },
          );
        });
      const client = new ConvexHttpClient("https://occ-delay.convex.cloud", {
        fetch: localFetch,
      });
      const high = client.mutation(
        mutation,
        { value: "high" },
        { priority: "high" },
      );
      const queued = client.mutation(mutation, { value: "queued" });
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        client.mutation(
          mutation,
          { value: "independent" },
          { skipQueue: true },
        ),
      ).resolves.toBe("ok");
      await vi.advanceTimersByTimeAsync(1999);
      expect(requests).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      await expect(Promise.all([high, queued])).resolves.toEqual(["ok", "ok"]);
      expect(requests).toMatchObject([
        { args: [{ value: "high" }], priority: "high" },
        { args: [{ value: "independent" }] },
        { args: [{ value: "high" }], priority: "high" },
        { args: [{ value: "queued" }] },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ConvexHttpClient mutation priority", () => {
  test("keeps each queued call's priority across write-conflict retries", async () => {
    const requests: unknown[] = [];
    const localFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify(
            requests.length === 1
              ? {
                  code: "OptimisticConcurrencyControlFailure",
                  message:
                    "Data read or written in this mutation changed while it was being run.",
                }
              : { status: "success", value: "ok" },
          ),
          {
            status: requests.length === 1 ? 503 : 200,
            headers: { "content-type": "application/json" },
          },
        );
      });
    const client = new ConvexHttpClient("https://priority.convex.cloud", {
      fetch: localFetch,
    });
    const high = client.mutation(
      mutation,
      { value: "urgent" },
      {
        priority: "high",
        writeConflictRetryDelayMs: 0,
      },
    );
    const normal = client.mutation(mutation, { value: "ordinary" });
    await expect(Promise.all([high, normal])).resolves.toEqual(["ok", "ok"]);
    expect(requests).toEqual([
      {
        path: "test:mutation",
        args: [{ value: "urgent" }],
        format: "convex_encoded_json",
        priority: "high",
      },
      {
        path: "test:mutation",
        args: [{ value: "urgent" }],
        format: "convex_encoded_json",
        priority: "high",
      },
      {
        path: "test:mutation",
        args: [{ value: "ordinary" }],
        format: "convex_encoded_json",
      },
    ]);
  });

  test("skipQueue sends high priority without waiting for an ordinary mutation", async () => {
    let resolveOrdinary!: (response: Response) => void;
    const ordinaryResponse = new Promise<Response>((resolve) => {
      resolveOrdinary = resolve;
    });
    const requests: unknown[] = [];
    const localFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return requests.length === 1
          ? ordinaryResponse
          : new Response(JSON.stringify({ status: "success", value: "high" }));
      });
    const client = new ConvexHttpClient("https://priority.convex.cloud", {
      fetch: localFetch,
    });
    const ordinary = client.mutation(
      mutation,
      { value: "ordinary" },
      { priority: "normal" },
    );
    await expect(
      client.mutation(
        mutation,
        { value: "urgent" },
        { priority: "high", skipQueue: true },
      ),
    ).resolves.toBe("high");
    expect(requests).toMatchObject([
      { args: [{ value: "ordinary" }] },
      { args: [{ value: "urgent" }], priority: "high" },
    ]);
    expect(requests[0]).not.toHaveProperty("priority");
    resolveOrdinary(
      new Response(JSON.stringify({ status: "success", value: "ordinary" })),
    );
    await expect(ordinary).resolves.toBe("ordinary");
  });

  test.each(["administrator", null, true, 1])(
    "rejects invalid priority %s before sending",
    async (priority) => {
      const localFetch = vi.fn<typeof fetch>();
      const client = new ConvexHttpClient("https://priority.convex.cloud", {
        fetch: localFetch,
      });
      await expect(
        client.mutation(
          mutation,
          { value: "invalid" },
          {
            // @ts-expect-error Verify the runtime boundary for untyped callers.
            priority,
          },
        ),
      ).rejects.toThrow('Mutation priority must be "normal" or "high".');
      expect(localFetch).not.toHaveBeenCalled();
    },
  );
});
