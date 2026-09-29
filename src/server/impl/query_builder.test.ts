import { afterEach, expect, test, vi } from "vitest";
import { IndexRangeBuilderImpl } from "./index_range_builder_impl.js";
import { SearchFilterBuilderImpl } from "./search_filter_builder_impl.js";
import { Value } from "../../values/value.js";

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
