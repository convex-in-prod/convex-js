import {
  QueryValue,
  queryValueArg,
  QueryRecord,
  queryRecordBuilder,
} from "./query_value.js";
import {
  FieldTypeFromFieldPath,
  GenericDocument,
  GenericSearchIndexConfig,
} from "../data_model.js";
import {
  SearchFilter,
  SearchFilterBuilder,
  SearchFilterFinalizer,
} from "../search_filter_builder.js";
import { validateArg } from "./validate.js";

export type SerializedSearchFilter =
  | QueryRecord
  | {
      type: "Search";
      fieldPath: string;
      value: string;
    }
  | {
      type: "Eq";
      fieldPath: string;
      value: QueryValue;
    };

export class SearchFilterBuilderImpl
  extends SearchFilter
  implements
    SearchFilterBuilder<GenericDocument, GenericSearchIndexConfig>,
    SearchFilterFinalizer<GenericDocument, GenericSearchIndexConfig>
{
  private filters: SerializedSearchFilter[];
  private isConsumed: boolean;
  private constructor(filters: SerializedSearchFilter[]) {
    super();
    this.filters = filters;
    this.isConsumed = false;
  }

  static new(): SearchFilterBuilderImpl {
    return new SearchFilterBuilderImpl([]);
  }

  private consume() {
    if (this.isConsumed) {
      throw new Error(
        "SearchFilterBuilder has already been used! Chain your method calls like `q => q.search(...).eq(...)`.",
      );
    }
    this.isConsumed = true;
  }

  search(
    fieldName: string,
    query: string,
  ): SearchFilterFinalizer<GenericDocument, GenericSearchIndexConfig> {
    validateArg(fieldName, 1, "search", "fieldName");
    validateArg(query, 2, "search", "query");
    this.consume();
    // Consumption transfers ownership to the successor; old wrappers cannot
    // append to or export this array again.
    const record = queryRecordBuilder();
    this.filters.push(
      record === undefined
        ? { type: "Search", fieldPath: fieldName, value: query }
        : record(26, fieldName, query),
    );
    return new SearchFilterBuilderImpl(this.filters);
  }
  eq<FieldName extends string>(
    fieldName: FieldName,
    value: FieldTypeFromFieldPath<GenericDocument, FieldName>,
  ): SearchFilterFinalizer<GenericDocument, GenericSearchIndexConfig> {
    validateArg(fieldName, 1, "eq", "fieldName");
    // when `undefined` is passed explicitly, it is allowed.
    if (arguments.length !== 2) {
      validateArg(value, 2, "search", "value");
    }
    this.consume();
    const captured = queryValueArg(value);
    const record = queryRecordBuilder();
    this.filters.push(
      record === undefined
        ? { type: "Eq", fieldPath: fieldName, value: captured }
        : record(27, fieldName, captured),
    );
    return new SearchFilterBuilderImpl(this.filters);
  }

  export(): ReadonlyArray<SerializedSearchFilter> {
    this.consume();
    return this.filters;
  }
}
