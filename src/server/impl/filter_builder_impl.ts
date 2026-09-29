import { Value, NumericValue } from "../../values/index.js";
import {
  QueryValue,
  queryValueArg,
  QueryRecord,
  queryRecordBuilder,
} from "./query_value.js";
import { GenericTableInfo } from "../data_model.js";
import {
  Expression,
  ExpressionOrValue,
  FilterBuilder,
} from "../filter_builder.js";

export type SerializedQueryExpression =
  | QueryRecord
  | {
      [operator: string]:
        | QueryValue
        | SerializedQueryExpression
        | SerializedQueryExpression[];
    };

// The `any` type parameter in `Expression<any>` allows us to use this class
// in place of any `Expression` type in `filterBuilderImpl`.
export class ExpressionImpl extends Expression<any> {
  private inner: SerializedQueryExpression;
  constructor(inner: SerializedQueryExpression) {
    super();
    this.inner = inner;
  }

  serialize(): SerializedQueryExpression {
    return this.inner;
  }
}

export function serializeExpression(
  expr: ExpressionOrValue<Value | undefined>,
): SerializedQueryExpression {
  if (expr instanceof ExpressionImpl) {
    return expr.serialize();
  } else {
    // Capture the literal now so mutations after query construction cannot
    // change the value observed when the query runs.
    const captured = queryValueArg(expr as Value | undefined);
    const record = queryRecordBuilder();
    return record === undefined ? { $literal: captured } : record(1, captured);
  }
}

export const filterBuilderImpl: FilterBuilder<GenericTableInfo> = {
  //  Comparisons  /////////////////////////////////////////////////////////////

  eq<T extends Value | undefined>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<boolean> {
    const left = serializeExpression(l);
    const right = serializeExpression(r);
    const record = queryRecordBuilder();
    return new ExpressionImpl(
      record === undefined ? { $eq: [left, right] } : record(3, left, right),
    );
  },

  neq<T extends Value | undefined>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<boolean> {
    const left = serializeExpression(l);
    const right = serializeExpression(r);
    const record = queryRecordBuilder();
    return new ExpressionImpl(
      record === undefined ? { $neq: [left, right] } : record(4, left, right),
    );
  },

  lt<T extends Value>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<boolean> {
    const left = serializeExpression(l);
    const right = serializeExpression(r);
    const record = queryRecordBuilder();
    return new ExpressionImpl(
      record === undefined ? { $lt: [left, right] } : record(5, left, right),
    );
  },

  lte<T extends Value>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<boolean> {
    const left = serializeExpression(l);
    const right = serializeExpression(r);
    const record = queryRecordBuilder();
    return new ExpressionImpl(
      record === undefined ? { $lte: [left, right] } : record(6, left, right),
    );
  },

  gt<T extends Value>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<boolean> {
    const left = serializeExpression(l);
    const right = serializeExpression(r);
    const record = queryRecordBuilder();
    return new ExpressionImpl(
      record === undefined ? { $gt: [left, right] } : record(7, left, right),
    );
  },

  gte<T extends Value>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<boolean> {
    const left = serializeExpression(l);
    const right = serializeExpression(r);
    const record = queryRecordBuilder();
    return new ExpressionImpl(
      record === undefined ? { $gte: [left, right] } : record(8, left, right),
    );
  },

  //  Arithmetic  //////////////////////////////////////////////////////////////

  add<T extends NumericValue>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<T> {
    const left = serializeExpression(l);
    const right = serializeExpression(r);
    const record = queryRecordBuilder();
    return new ExpressionImpl(
      record === undefined ? { $add: [left, right] } : record(9, left, right),
    );
  },

  sub<T extends NumericValue>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<T> {
    const left = serializeExpression(l);
    const right = serializeExpression(r);
    const record = queryRecordBuilder();
    return new ExpressionImpl(
      record === undefined ? { $sub: [left, right] } : record(10, left, right),
    );
  },

  mul<T extends NumericValue>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<T> {
    const left = serializeExpression(l);
    const right = serializeExpression(r);
    const record = queryRecordBuilder();
    return new ExpressionImpl(
      record === undefined ? { $mul: [left, right] } : record(11, left, right),
    );
  },

  div<T extends NumericValue>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<T> {
    const left = serializeExpression(l);
    const right = serializeExpression(r);
    const record = queryRecordBuilder();
    return new ExpressionImpl(
      record === undefined ? { $div: [left, right] } : record(12, left, right),
    );
  },

  mod<T extends NumericValue>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<T> {
    const left = serializeExpression(l);
    const right = serializeExpression(r);
    const record = queryRecordBuilder();
    return new ExpressionImpl(
      record === undefined ? { $mod: [left, right] } : record(13, left, right),
    );
  },

  neg<T extends NumericValue>(x: ExpressionOrValue<T>): Expression<T> {
    const expression = serializeExpression(x);
    const record = queryRecordBuilder();
    return new ExpressionImpl(
      record === undefined ? { $neg: expression } : record(14, expression),
    );
  },

  //  Logic  ///////////////////////////////////////////////////////////////////

  and(...exprs: Array<ExpressionOrValue<boolean>>): Expression<boolean> {
    const expressions = exprs.map(serializeExpression);
    const record = queryRecordBuilder();
    return new ExpressionImpl(
      record === undefined ? { $and: expressions } : record(16, expressions),
    );
  },

  or(...exprs: Array<ExpressionOrValue<boolean>>): Expression<boolean> {
    const expressions = exprs.map(serializeExpression);
    const record = queryRecordBuilder();
    return new ExpressionImpl(
      record === undefined ? { $or: expressions } : record(17, expressions),
    );
  },

  not(x: ExpressionOrValue<boolean>): Expression<boolean> {
    const expression = serializeExpression(x);
    const record = queryRecordBuilder();
    return new ExpressionImpl(
      record === undefined ? { $not: expression } : record(15, expression),
    );
  },

  //  Other  ///////////////////////////////////////////////////////////////////
  field(fieldPath: string): Expression<any> {
    const record = queryRecordBuilder();
    return new ExpressionImpl(
      record === undefined ? { $field: fieldPath } : record(2, fieldPath),
    );
  },
};
