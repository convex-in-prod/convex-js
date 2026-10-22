import { expect, test, vi } from "vitest";
import { buildProgram } from "./program.js";

const { fetchRequest } = vi.hoisted(() => {
  const fetchRequest = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchRequest);
  return { fetchRequest };
});

vi.mock("../bundler/context.js", async (original) => ({
  ...(await original<typeof import("../bundler/context.js")>()),
  oneoffContext: async () => ({
    crash: async ({ printedMessage }: { printedMessage: string }) => {
      throw new Error(printedMessage);
    },
  }),
}));
vi.mock("./lib/deploymentSelection.js", async (original) => ({
  ...(await original<typeof import("./lib/deploymentSelection.js")>()),
  getDeploymentSelection: async () => ({ kind: "anonymous" }),
}));
vi.mock("./lib/api.js", async (original) => ({
  ...(await original<typeof import("./lib/api.js")>()),
  loadSelectedDeploymentCredentials: async () => ({
    url: "http://127.0.0.1:3210",
    adminKey: "test-key",
  }),
}));

test("a rejected promotion reports baseline shortage without replay or raw diagnostics", async () => {
  fetchRequest.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        snapshot: {
          revision: 7,
          policy: {
            query: { primary: "v8", shadowBps: 125 },
            mutation: { primary: "v8", shadowBps: 0 },
          },
        },
        durable: true,
        quarantinedSelectors: 0,
        quarantineInitialized: true,
      }),
    ),
  );
  fetchRequest.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        code: "StaticHermesWasmBaselineCapacityUnavailable",
        message: "private loader detail /private/artifacts",
      }),
      { status: 409 },
    ),
  );

  await expect(
    buildProgram()
      .exitOverride()
      .parseAsync(["runtime-mode", "--primary", "wasm"], { from: "user" }),
  ).rejects.toThrow(
    "Wasm preparation could not establish baseline capacity for every applicable group. Read runtime-mode status before retrying an update.",
  );
  expect(fetchRequest).toHaveBeenCalledTimes(2);
  const [url, options] = fetchRequest.mock.calls[1];
  expect(String(url)).toBe("http://127.0.0.1:3210/api/wasm_runtime_policy");
  expect(options?.method).toBe("POST");
  expect(options?.redirect).toBe("error");
  expect(options?.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(String(options?.body))).toEqual({
    expectedRevision: 7,
    policy: {
      query: { primary: "wasm", shadowBps: 125 },
      mutation: { primary: "wasm", shadowBps: 0 },
    },
  });
});
