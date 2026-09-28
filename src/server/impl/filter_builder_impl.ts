import { Value, NumericValue } from "../../values/index.js";
import { QueryValue, queryValueArg } from "./query_value.js";
import { GenericTableInfo } from "../data_model.js";
import {
  Expression,
  ExpressionOrValue,
  FilterBuilder,
} from "../filter_builder.js";

export type SerializedQueryExpression = {
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
    return { $literal: queryValueArg(expr as Value | undefined) };
  }
}

export const filterBuilderImpl: FilterBuilder<GenericTableInfo> = {
  //  Comparisons  /////////////////////////////////////////////////////////////

  eq<T extends Value | undefined>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<boolean> {
    return new ExpressionImpl({
      $eq: [serializeExpression(l), serializeExpression(r)],
    });
  },

  neq<T extends Value | undefined>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<boolean> {
    return new ExpressionImpl({
      $neq: [serializeExpression(l), serializeExpression(r)],
    });
  },

  lt<T extends Value>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<boolean> {
    return new ExpressionImpl({
      $lt: [serializeExpression(l), serializeExpression(r)],
    });
  },

  lte<T extends Value>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<boolean> {
    return new ExpressionImpl({
      $lte: [serializeExpression(l), serializeExpression(r)],
    });
  },

  gt<T extends Value>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<boolean> {
    return new ExpressionImpl({
      $gt: [serializeExpression(l), serializeExpression(r)],
    });
  },

  gte<T extends Value>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<boolean> {
    return new ExpressionImpl({
      $gte: [serializeExpression(l), serializeExpression(r)],
    });
  },

  //  Arithmetic  //////////////////////////////////////////////////////////////

  add<T extends NumericValue>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<T> {
    return new ExpressionImpl({
      $add: [serializeExpression(l), serializeExpression(r)],
    });
  },

  sub<T extends NumericValue>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<T> {
    return new ExpressionImpl({
      $sub: [serializeExpression(l), serializeExpression(r)],
    });
  },

  mul<T extends NumericValue>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<T> {
    return new ExpressionImpl({
      $mul: [serializeExpression(l), serializeExpression(r)],
    });
  },

  div<T extends NumericValue>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<T> {
    return new ExpressionImpl({
      $div: [serializeExpression(l), serializeExpression(r)],
    });
  },

  mod<T extends NumericValue>(
    l: ExpressionOrValue<T>,
    r: ExpressionOrValue<T>,
  ): Expression<T> {
    return new ExpressionImpl({
      $mod: [serializeExpression(l), serializeExpression(r)],
    });
  },

  neg<T extends NumericValue>(x: ExpressionOrValue<T>): Expression<T> {
    return new ExpressionImpl({ $neg: serializeExpression(x) });
  },

  //  Logic  ///////////////////////////////////////////////////////////////////

  and(...exprs: Array<ExpressionOrValue<boolean>>): Expression<boolean> {
    return new ExpressionImpl({ $and: exprs.map(serializeExpression) });
  },

  or(...exprs: Array<ExpressionOrValue<boolean>>): Expression<boolean> {
    return new ExpressionImpl({ $or: exprs.map(serializeExpression) });
  },

  not(x: ExpressionOrValue<boolean>): Expression<boolean> {
    return new ExpressionImpl({ $not: serializeExpression(x) });
  },

  //  Other  ///////////////////////////////////////////////////////////////////
  field(fieldPath: string): Expression<any> {
    return new ExpressionImpl({ $field: fieldPath });
  },
};
