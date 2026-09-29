import { expect, test } from "vitest";

import { convexToJson, jsonToConvex, jsonToConvexOwned } from "./value.js";

test("decodes freshly parsed values in place without changing the public decoder", () => {
  const encoded = convexToJson({
    nested: [{ count: 7n, bytes: new Uint8Array([1, 2]).buffer }],
    ordinary: { enabled: true },
  });
  const parsed = JSON.parse(JSON.stringify(encoded));
  const nested = parsed.nested;
  const ordinary = parsed.ordinary;

  const decoded = jsonToConvexOwned(parsed);
  expect(decoded).toBe(parsed);
  expect(parsed.nested).toBe(nested);
  expect(parsed.ordinary).toBe(ordinary);
  expect(decoded).toEqual({
    nested: [{ count: 7n, bytes: new Uint8Array([1, 2]).buffer }],
    ordinary: { enabled: true },
  });

  const publicInput = JSON.parse(JSON.stringify(encoded));
  expect(jsonToConvex(publicInput)).not.toBe(publicInput);
  expect(publicInput).toEqual(encoded);
});

test("owned conversion retains an own __proto__ field and rejects malformed tags", () => {
  const parsed = JSON.parse('{"__proto__":{"enabled":true}}');
  expect(jsonToConvexOwned(parsed)).toBe(parsed);
  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
  expect(parsed["__proto__"]).toEqual({ enabled: true });

  const publicDecoded = jsonToConvex(
    JSON.parse('{"__proto__":{"enabled":true}}'),
  );
  if (publicDecoded === null || typeof publicDecoded !== "object") {
    throw new Error("Expected an object after decoding");
  }
  expect(Object.hasOwn(publicDecoded, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(publicDecoded)).toBe(Object.prototype);

  expect(() => jsonToConvexOwned({ $integer: 3 })).toThrow(
    /Malformed \$integer field/u,
  );
});
