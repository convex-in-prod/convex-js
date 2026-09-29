import { expect, test } from "vitest";

import { compareUTF8 } from "./compare_utf8.js";

const encoder = new TextEncoder();

function compareEncoded(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

test("compares strings by their UTF-8 byte order", () => {
  const values = [
    "",
    "a",
    "\u007f",
    "\u0080",
    "é",
    "éa",
    "éb",
    "é",
    "\u07ff",
    "\u0800",
    "€",
    "中",
    "\ud7ff",
    "\ue000",
    "\uffff",
    "𐀀",
    "😀",
    "😀a",
    "😀b",
    "\u{10ffff}",
  ];
  for (const left of values) {
    for (const right of values) {
      expect(Math.sign(compareUTF8(left, right))).toBe(
        Math.sign(compareEncoded(left, right)),
      );
    }
  }
});

test("retains the established ordering of lone UTF-16 surrogates", () => {
  const values = [
    "\ud7ff",
    "\ud800",
    "\ud801",
    "\udbff",
    "\udc00",
    "\udfff",
    "\ue000",
    "\ufffd",
    "\ud800\udc00",
  ];
  for (const [leftIndex, left] of values.entries()) {
    for (const [rightIndex, right] of values.entries()) {
      expect(Math.sign(compareUTF8(left, right))).toBe(
        Math.sign(leftIndex - rightIndex),
      );
    }
  }
});
