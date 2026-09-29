import { afterEach, expect, test, vi } from "vitest";

import { setupMutationMeta, setupQueryMeta } from "./meta_impl.js";

afterEach(() => vi.unstubAllGlobals());

test("deployment metadata preserves native authority and distinguishes unsupported backends", async () => {
  const nativeResident = {
    artifactSha256: "a".repeat(64),
    configurationSha256: "b".repeat(64),
    lifecycleProtocol: 1,
    applicationContract: "example-v1",
  };
  for (const selection of [nativeResident, null, undefined]) {
    const response = {
      name: "example",
      region: null,
      class: "s16",
      ...(selection === undefined ? {} : { nativeResident: selection }),
    };
    vi.stubGlobal("Convex", {
      asyncSyscall: async () => JSON.stringify(response),
    });
    for (const meta of [
      setupQueryMeta("internal"),
      setupMutationMeta("internal"),
    ]) {
      const actual = await meta.getDeploymentMetadata();
      expect(actual).toEqual(response);
      expect(Object.hasOwn(actual, "nativeResident")).toBe(
        selection !== undefined,
      );
    }
  }
});
