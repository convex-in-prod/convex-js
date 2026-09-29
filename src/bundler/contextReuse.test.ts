import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { hash, partitionModulesByChanges } from "../cli/lib/components.js";
import type { Context } from "./context.js";
import {
  applyDefaultContextReusePolicy,
  bundle,
  type Bundle,
  nodeFs,
} from "./index.js";

const testContext: Context = {
  fs: nodeFs,
  deprecationMessagePrinted: false,
  async crash({ printedMessage }) {
    throw new Error(printedMessage ?? "Bundling failed");
  },
  registerCleanup() {
    return "unused";
  },
  removeCleanup() {
    return async () => {};
  },
  bigBrainAuth() {
    return null;
  },
  _updateBigBrainAuth() {},
};

describe("default context reuse export", () => {
  test("adds the upstream marker before an external source map comment", async () => {
    expect(
      await applyDefaultContextReusePolicy(
        testContext,
        "const value = 1;\nexport { value };\n//# sourceMappingURL=entry.js.map\n",
        { enabled: true, httpActions: false, entry: "included.ts" },
      ),
    ).toBe(
      "const value = 1;\nexport { value };\nexport const experimental_reuseContext = true;\n//# sourceMappingURL=entry.js.map\n",
    );
  });

  test("adds a typed policy when HTTP action reuse is enabled", async () => {
    expect(
      await applyDefaultContextReusePolicy(
        testContext,
        "const value = 1;\nexport { value };\n",
        { enabled: true, httpActions: true, entry: "http.ts" },
      ),
    ).toBe(
      "const value = 1;\nexport { value };\nexport const experimental_reuseContext = { queries: true, mutations: true, actions: false, httpActions: true };\n",
    );
  });

  test("leaves an excluded entry unchanged", async () => {
    const source = "const value = 1;\nexport { value };\n";

    expect(
      await applyDefaultContextReusePolicy(testContext, source, {
        enabled: false,
        httpActions: true,
        entry: "excluded.ts",
      }),
    ).toBe(source);
  });

  test("marker removal changes the entry hash without resending unchanged modules", async () => {
    const source = "const value = 1;\nexport { value };\n";
    const markedEntry: Bundle = {
      path: "entry.js",
      source: await applyDefaultContextReusePolicy(testContext, source, {
        enabled: true,
        httpActions: false,
        entry: "entry.ts",
      }),
      environment: "isolate",
    };
    const freshEntry: Bundle = {
      ...markedEntry,
      source: await applyDefaultContextReusePolicy(testContext, source, {
        enabled: false,
        httpActions: false,
        entry: "entry.ts",
      }),
    };
    const sharedModule: Bundle = {
      path: "_deps/shared.js",
      source: "export const shared = true;\n",
      environment: "isolate",
    };
    const remoteHashes = new Map([
      [
        markedEntry.path,
        {
          path: markedEntry.path,
          hash: hash(markedEntry),
          environment: markedEntry.environment,
        },
      ],
      [
        sharedModule.path,
        {
          path: sharedModule.path,
          hash: hash(sharedModule),
          environment: sharedModule.environment,
        },
      ],
    ]);

    const { changedModules, unchangedModuleHashes } = partitionModulesByChanges(
      [freshEntry, sharedModule],
      remoteHashes,
    );

    expect(changedModules).toEqual([freshEntry]);
    expect(unchangedModuleHashes).toEqual([
      {
        path: sharedModule.path,
        environment: sharedModule.environment,
        sha256: hash(sharedModule),
      },
    ]);
  });

  test("rejects an entry that also owns the marker", async () => {
    await expect(
      applyDefaultContextReusePolicy(
        testContext,
        "const marker = true;\nexport { marker as experimental_reuseContext };\n",
        { enabled: false, httpActions: false, entry: "marked.ts" },
      ),
    ).rejects.toThrow(/marked\.ts.*must not export experimental_reuseContext/u);
    await expect(
      applyDefaultContextReusePolicy(
        testContext,
        "export const experimental_reuseContext = true;\n",
        { enabled: true, httpActions: false, entry: "marked.ts" },
      ),
    ).rejects.toThrow(/marked\.ts.*must not export experimental_reuseContext/u);
  });

  test("marks root entries and leaves configured exclusions fresh", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "convex-context-reuse-"));
    const included = path.join(rootDir, "included.ts");
    const excluded = path.join(rootDir, "excluded.ts");
    try {
      await Promise.all([
        writeFile(included, "export const included = 1;\n"),
        writeFile(excluded, "export const excluded = 2;\n"),
      ]);

      const result = await bundle({
        ctx: testContext,
        dir: rootDir,
        entryPoints: [included, excluded],
        generateSourceMaps: true,
        platform: "browser",
        experimentalContextReuse: {
          rootDir,
          exclusions: {
            "excluded.ts":
              "This fixture entry remains fresh to verify the bundle-time exclusion path.",
          },
          httpActions: true,
        },
      });

      const includedBundle = result.modules.find(
        (module) => module.path === "included.js",
      );
      const excludedBundle = result.modules.find(
        (module) => module.path === "excluded.js",
      );
      expect(includedBundle?.source).toContain(
        "export const experimental_reuseContext = { queries: true, mutations: true, actions: false, httpActions: true };",
      );
      expect(excludedBundle?.source).not.toContain("experimental_reuseContext");
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  test("rejects an exclusion that does not name a root isolate entry", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "convex-context-reuse-"));
    const included = path.join(rootDir, "included.ts");
    try {
      await writeFile(included, "export const included = 1;\n");

      await expect(
        bundle({
          ctx: testContext,
          dir: rootDir,
          entryPoints: [included],
          generateSourceMaps: true,
          platform: "browser",
          experimentalContextReuse: {
            rootDir,
            exclusions: {
              "stale.ts":
                "This fixture path must fail because it is not a root isolate entry.",
            },
            httpActions: false,
          },
        }),
      ).rejects.toThrow(/Unmatched exclusions: stale\.ts/u);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  test("initializes equivalent forwarding entries together and preserves their exports", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "convex-context-group-"));
    try {
      await Promise.all([
        writeFile(
          path.join(rootDir, "shared.ts"),
          `
          globalThis.loads = (globalThis.loads ?? 0) + 1;
          export const first = (arg) => ["first", arg, globalThis.loads];
          export const second = (arg) => ["second", arg, globalThis.loads];
          export const third = () => "third";
        `,
        ),
        ...["first", "second", "third"].map((name) =>
          writeFile(
            path.join(rootDir, `${name}.ts`),
            `export { ${name} as run } from "./shared";`,
          ),
        ),
        writeFile(
          path.join(rootDir, "local.ts"),
          `
          import { first } from "./shared";
          export const run = first(Date.now());
        `,
        ),
      ]);
      const options = {
        ctx: testContext,
        dir: rootDir,
        entryPoints: ["first", "second", "third", "local"].map((name) =>
          path.join(rootDir, `${name}.ts`),
        ),
        generateSourceMaps: true,
        platform: "browser" as const,
      };
      const full = await bundle({
        ...options,
        experimentalContextReuse: {
          rootDir,
          exclusions: {},
          httpActions: true,
        },
      });
      const initializer = full.modules.find((m) =>
        m.path.includes("context_init_"),
      );
      expect(initializer).toBeDefined();
      // Backend module paths limit each component, including `.js`, to 64 bytes.
      expect(
        Buffer.byteLength(path.posix.basename(initializer!.path)),
      ).toBeLessThanOrEqual(64);
      expect(initializer!.source).not.toContain("local.js");
      expect(
        full.modules.find((m) => m.path === "local.js")!.source,
      ).not.toContain("initializationModule");

      // Execute the deployed ESM graph, including the unbundled initializer.
      // A text-only assertion would miss broken relative imports or exports.
      const deployed = path.join(rootDir, "deployed");
      await mkdir(deployed);
      await writeFile(path.join(deployed, "package.json"), '{"type":"module"}');
      await Promise.all(
        full.modules.map(async (m) => {
          const target = path.join(deployed, m.path);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, m.source);
        }),
      );
      const url = (name: string) =>
        JSON.stringify(pathToFileURL(path.join(deployed, name)).href);
      const { stdout } = await promisify(execFile)(process.execPath, [
        "--input-type=module",
        "-e",
        `
          await import(${url(initializer!.path)});
          const first = await import(${url("first.js")});
          const second = await import(${url("second.js")});
          console.log(JSON.stringify({
            results: [first.run(10), second.run(20)],
            policies: [first.experimental_reuseContext, second.experimental_reuseContext],
          }));
        `,
      ]);
      expect(JSON.parse(stdout)).toEqual({
        results: [
          ["first", 10, 1],
          ["second", 20, 1],
        ],
        policies: [0, 1].map(() => ({
          queries: true,
          mutations: true,
          actions: false,
          httpActions: true,
          initializationModule: initializer!.path,
        })),
      });

      const excluded = await bundle({
        ...options,
        experimentalContextReuse: {
          rootDir,
          exclusions: { "third.ts": "Keep this entry fresh." },
          httpActions: true,
        },
      });
      const smaller = excluded.modules.find((m) =>
        m.path.includes("context_init_"),
      )!;
      expect(smaller.path).not.toBe(initializer!.path);
      expect(smaller.source).not.toContain("third.js");
      expect(
        excluded.modules.find((m) => m.path === "third.js")!.source,
      ).not.toContain("experimental_reuseContext");

      const disabled = await bundle(options);
      expect(
        disabled.modules.some((m) => m.path.includes("context_init_")),
      ).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
