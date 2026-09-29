import { afterEach, expect, test, vi } from "vitest";
import { IndexRangeBuilderImpl } from "./index_range_builder_impl.js";
import { SearchFilterBuilderImpl } from "./search_filter_builder_impl.js";
import { Value } from "../../values/value.js";
import { serializeExpression } from "./filter_builder_impl.js";

afterEach(() => vi.unstubAllGlobals());

for (const typed of [false, true]) {
  test(`builders transfer ownership and snapshot values (${typed ? "typed" : "JSON"})`, () => {
    if (typed) {
      vi.stubGlobal("Convex", {
        typedQueryArgs: true,
        captureQueryValue: (value: Value) =>
          new TextEncoder().encode(JSON.stringify(value)).buffer,
      });
    }
    const value = { nested: [1] };
    const root = IndexRangeBuilderImpl.new();
    const middle = root.eq("a", value);
    const final = middle.gte("b", 2).lt("b", 8);
    value.nested.push(9);
    const range = final.export().map((entry) => {
      if (!("type" in entry))
        throw new Error("Expected legacy range expression");
      return entry;
    });
    expect(range.map(({ type }) => type)).toEqual(["Eq", "Gte", "Lt"]);
    expect(
      typed
        ? JSON.parse(new TextDecoder().decode(range[0].value as ArrayBuffer))
        : range[0].value,
    ).toEqual({ nested: [1] });
    for (const old of [root, middle, final]) {
      expect(() => old.eq("c", 3)).toThrow("already been used");
      expect(() => old.export()).toThrow("already been used");
    }
    const search = SearchFilterBuilderImpl.new();
    const withTerm = search.search("text", "term");
    const withFilter = withTerm.eq("a", value);
    value.nested.push(10);
    expect(() => search.eq("a", 3)).toThrow("already been used");
    expect(() => withTerm.eq("a", 3)).toThrow("already been used");
    const filters = (withFilter as SearchFilterBuilderImpl)
      .export()
      .map((entry) => {
        if (!("type" in entry))
          throw new Error("Expected legacy search filter");
        return entry;
      });
    expect(filters[0]).toEqual({
      type: "Search",
      fieldPath: "text",
      value: "term",
    });
    expect(
      typed
        ? JSON.parse(new TextDecoder().decode(filters[1].value as ArrayBuffer))
        : filters[1].value,
    ).toEqual({ nested: [1, 9] });
    expect(() => (withFilter as SearchFilterBuilderImpl).export()).toThrow(
      "already been used",
    );
  });
}

test("reentrant and throwing value capture cannot reuse a consumed builder", () => {
  for (const builder of [
    IndexRangeBuilderImpl.new(),
    SearchFilterBuilderImpl.new(),
  ]) {
    const value = {
      get field(): never {
        expect(() => builder.eq("reentrant", 1)).toThrow("already been used");
        throw new Error("capture failed");
      },
    };
    expect(() => builder.eq("a", value)).toThrow("capture failed");
    expect(() => builder.export()).toThrow("already been used");
  }
});

test("combined records snapshot values and preserve consumed builders on failure", () => {
  const records = new Map<
    object,
    { kind: number; field: string | undefined; value: Value | undefined }
  >();
  vi.stubGlobal("Convex", {
    queryValueRecord: (
      kind: number,
      field: string | undefined,
      value: Value | undefined,
    ) => {
      const record = Object.freeze({});
      records.set(record, { kind, field, value: structuredClone(value) });
      return record;
    },
  });
  const value = { nested: [1] };
  const root = IndexRangeBuilderImpl.new();
  const range = root.eq("a", value).gte("b", 2).lt("b", 8).export();
  const search = SearchFilterBuilderImpl.new().eq(
    "a",
    value,
  ) as SearchFilterBuilderImpl;
  const literal = serializeExpression(value);
  const missing = serializeExpression(undefined);
  value.nested.push(9);
  expect(range.map((entry) => records.get(entry)?.kind)).toEqual([21, 23, 24]);
  expect(records.get(range[0])?.value).toEqual({ nested: [1] });
  expect(records.get(search.export()[0])).toEqual({
    kind: 27,
    field: "a",
    value: { nested: [1] },
  });
  expect(records.get(literal)).toEqual({
    kind: 1,
    field: undefined,
    value: { nested: [1] },
  });
  expect(records.get(missing)).toEqual({
    kind: 1,
    field: undefined,
    value: undefined,
  });
  expect(() => root.export()).toThrow("already been used");

  for (const builder of [
    IndexRangeBuilderImpl.new(),
    SearchFilterBuilderImpl.new(),
  ]) {
    vi.stubGlobal("Convex", {
      queryValueRecord: () => {
        expect(() => builder.eq("again", 1)).toThrow("already been used");
        throw new Error("capture failed");
      },
    });
    expect(() => builder.eq("a", value)).toThrow("capture failed");
    expect(() => builder.export()).toThrow("already been used");
  }
});
