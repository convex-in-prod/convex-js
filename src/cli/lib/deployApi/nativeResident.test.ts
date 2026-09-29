import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";
import type { Context } from "../../../bundler/context.js";
import { nodeFs } from "../../../bundler/fs.js";
import { finishPush } from "../deploy2.js";
import { Span } from "../tracing.js";
import { readNativeResidentActivation } from "./nativeResident.js";
import { startPushResponse } from "./startPush.js";

const { requests } = vi.hoisted(() => ({ requests: [] as unknown[] }));
vi.mock("../utils/utils.js", async (original) => ({
  ...(await original<typeof import("../utils/utils.js")>()),
  deploymentFetch: () => async (_path: string, options: { body: Buffer }) => {
    requests.push(
      JSON.parse(brotliDecompressSync(options.body).toString("utf8")),
    );
    return new Response(
      JSON.stringify({
        authDiff: { added: [], removed: [] },
        definitionDiffs: {},
        componentDiffs: {},
      }),
    );
  },
}));
const ctx: Context = {
  fs: nodeFs,
  deprecationMessagePrinted: false,
  crash: async ({ printedMessage }) => {
    throw new Error(printedMessage ?? "crash");
  },
  registerCleanup: () => "cleanup",
  removeCleanup: () => async () => {},
  bigBrainAuth: () => null,
  _updateBigBrainAuth: () => {},
};
const descriptor = {
  artifactSha256: "a".repeat(64),
  configurationSha256: "b".repeat(64),
  lifecycleProtocol: 1,
  applicationContract: "example-v1",
};
const directory = mkdtempSync(join(tmpdir(), "native-deploy-cli-"));
afterEach(() => {
  requests.length = 0;
});
const options = {
  adminKey: "test-key",
  url: "http://127.0.0.1:3210",
  dryRun: false,
  deploymentName: null,
  message: null,
  forceNodeCutover: false,
};
const start = startPushResponse.parse({
  environmentVariables: {},
  externalDepsId: null,
  componentDefinitionPackages: {},
  appAuth: [],
  analysis: {},
  app: {
    definitionPath: "",
    componentPath: "",
    args: {},
    childComponents: {},
    httpRoutes: { httpModuleRoutes: null, mounts: [] },
    exports: {},
  },
  schemaChange: { allocatedComponentIds: {}, schemaIds: {} },
});

test("finish push retains a file's original selection across repeated calls and dry run", async () => {
  const path = join(directory, "selection.json");
  const envelope = {
    expectedPrior: null,
    target: descriptor,
    applicationContract: "example-v1",
  };
  writeFileSync(path, JSON.stringify(envelope));
  const nativeResident = await readNativeResidentActivation(ctx, path);
  writeFileSync(path, JSON.stringify({ ...envelope, target: null }));
  await finishPush(ctx, Span.noop(), start, { ...options, nativeResident });
  await finishPush(ctx, Span.noop(), start, {
    ...options,
    nativeResident,
    dryRun: true,
  });
  expect(requests).toEqual([
    expect.objectContaining({ nativeResident: envelope, dryRun: false }),
    expect.objectContaining({ nativeResident: envelope, dryRun: true }),
  ]);
});

test("finish push preserves omission and explicit retirement", async () => {
  await finishPush(ctx, Span.noop(), start, options);
  const path = join(directory, "retire.json");
  const envelope = {
    expectedPrior: descriptor,
    target: null,
    applicationContract: "example-v1",
  };
  writeFileSync(path, JSON.stringify(envelope));
  await finishPush(ctx, Span.noop(), start, {
    ...options,
    nativeResident: await readNativeResidentActivation(ctx, path),
  });
  expect(requests[0]).not.toHaveProperty("nativeResident");
  expect(requests[1]).toHaveProperty("nativeResident", envelope);
});

test.each([
  { target: null, applicationContract: null },
  { expectedPrior: null, applicationContract: null },
  {
    expectedPrior: null,
    target: { ...descriptor, lifecycleProtocol: 2 },
    applicationContract: "example-v1",
  },
  {
    expectedPrior: null,
    target: descriptor,
    applicationContract: "different-v1",
  },
  {
    expectedPrior: null,
    target: null,
    applicationContract: null,
    watcherKey: "secret",
  },
])(
  "malformed envelopes fail before publication without their contents",
  async (value) => {
    const path = join(directory, "invalid.json");
    writeFileSync(path, JSON.stringify(value));
    await expect(readNativeResidentActivation(ctx, path)).rejects.toThrow(
      "valid deployment envelope",
    );
    expect(requests).toHaveLength(0);
  },
);

process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
