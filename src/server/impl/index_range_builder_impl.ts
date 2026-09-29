import { Value } from "../../values/index.js";
import {
  QueryValue,
  queryValueArg,
  QueryRecord,
  queryRecordBuilder,
} from "./query_value.js";
import { GenericDocument, GenericIndexFields } from "../data_model.js";
import {
  IndexRange,
  IndexRangeBuilder,
  LowerBoundIndexRangeBuilder,
  UpperBoundIndexRangeBuilder,
} from "../index_range_builder.js";

type RangeComparison = "Eq" | "Gt" | "Gte" | "Lt" | "Lte";
export type SerializedRangeExpression =
  | QueryRecord
  | {
      type: RangeComparison;
      fieldPath: string;
      value: QueryValue;
    };

export class IndexRangeBuilderImpl
  extends IndexRange
  implements
    IndexRangeBuilder<GenericDocument, GenericIndexFields>,
    LowerBoundIndexRangeBuilder<GenericDocument, string>,
    UpperBoundIndexRangeBuilder<GenericDocument, string>
{
  private rangeExpressions: SerializedRangeExpression[];
  private isConsumed: boolean;
  private constructor(rangeExpressions: SerializedRangeExpression[]) {
    super();
    this.rangeExpressions = rangeExpressions;
    this.isConsumed = false;
  }

  static new(): IndexRangeBuilderImpl {
    return new IndexRangeBuilderImpl([]);
  }

  private consume() {
    if (this.isConsumed) {
      throw new Error(
        "IndexRangeBuilder has already been used! Chain your method calls like `q => q.eq(...).eq(...)`. See https://docs.convex.dev/using/indexes",
      );
    }
    this.isConsumed = true;
  }

  private append(type: RangeComparison, fieldName: string, value: Value) {
    this.consume();
    // Only the successor may use this storage. Capture the value after consuming
    // this wrapper so a reentrant getter cannot branch from the same builder.
    const captured = queryValueArg(value);
    const record = queryRecordBuilder();
    this.rangeExpressions.push(
      record === undefined
        ? { type, fieldPath: fieldName, value: captured }
        : record(
            type === "Eq"
              ? 21
              : type === "Gt"
                ? 22
                : type === "Gte"
                  ? 23
                  : type === "Lt"
                    ? 24
                    : 25,
            fieldName,
            captured,
          ),
    );
    return new IndexRangeBuilderImpl(this.rangeExpressions);
  }

  eq(fieldName: string, value: Value) {
    return this.append("Eq", fieldName, value);
  }

  gt(fieldName: string, value: Value) {
    return this.append("Gt", fieldName, value);
  }
  gte(fieldName: string, value: Value) {
    return this.append("Gte", fieldName, value);
  }
  lt(fieldName: string, value: Value) {
    return this.append("Lt", fieldName, value);
  }
  lte(fieldName: string, value: Value) {
    return this.append("Lte", fieldName, value);
  }

  export(): ReadonlyArray<SerializedRangeExpression> {
    this.consume();
    return this.rangeExpressions;
  }
}
