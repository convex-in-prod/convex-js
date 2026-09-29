import { expect, test } from "vitest";
import { evaluatePushResponse } from "./startPush.js";

const schemaChange = {
  allocatedComponentIds: {},
  schemaIds: {},
};

test("evaluate push preserves missing analysis for version checks", () => {
  const parsed = evaluatePushResponse.parse({ schemaChange });

  expect(parsed.analysis).toBeUndefined();
});

test("evaluate push preserves codegen analysis", () => {
  const parsed = evaluatePushResponse.parse({
    analysis: {},
    schemaChange,
  });

  expect(parsed.analysis).toEqual({});
});
