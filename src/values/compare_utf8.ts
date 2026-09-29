/**
 * Taken from https://github.com/rocicorp/compare-utf8/blob/main/LICENSE
 * (Apache Version 2.0, January 2004)
 */

/**
 * This is copied here instead of added as a dependency to avoid bundling issues.
 */

/**
 * Compares two JavaScript strings as if they were UTF-8 encoded byte arrays.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareUTF8(a: string, b: string): number {
  const aLength = a.length;
  const bLength = b.length;
  const length = Math.min(aLength, bLength);
  for (let i = 0; i < length; ) {
    const aCodePoint = a.codePointAt(i)!;
    const bCodePoint = b.codePointAt(i)!;
    if (aCodePoint !== bCodePoint) {
      // UTF-8 preserves code point order. This also preserves the previous
      // ordering of lone surrogate code units, which codePointAt returns as-is.
      return aCodePoint - bCodePoint;
    }

    i += aCodePoint > 0xffff ? 2 : 1;
  }

  return aLength - bLength;
}
