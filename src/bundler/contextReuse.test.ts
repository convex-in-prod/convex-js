import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
});
