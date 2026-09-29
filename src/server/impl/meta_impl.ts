import { jsonToConvexOwned } from "../../values/value.js";
import {
  ActionMeta,
  MutationMeta,
  QueryMeta,
  RequestMetadata,
  FunctionMetadata,
  TransactionMetrics,
  DeploymentMetadata,
} from "../meta.js";
import {
  ValueSyscall,
  performAsyncValueSyscall,
  performSyscall,
} from "./syscall.js";

async function getTransactionMetrics(): Promise<TransactionMetrics> {
  let metrics;
  try {
    metrics = await performAsyncValueSyscall<TransactionMetrics>(
      ValueSyscall.TransactionMetrics,
      [],
      () => ({}),
      (result) => jsonToConvexOwned(result) as TransactionMetrics,
    );
  } catch (e: any) {
    if (e.message?.includes("Unknown async operation")) {
      throw new Error(
        "getTransactionMetrics() can only be called from a query or mutation. " +
          "It is not available in actions or outside of a Convex function.",
      );
    }
    throw e;
  }
  return metrics;
}

async function getFunctionMetadata(): Promise<{
  name: string;
  componentPath: string;
}> {
  const { name, componentPath } = await performAsyncValueSyscall<{
    name: string;
    componentPath: string;
  }>(
    ValueSyscall.FunctionMetadata,
    [],
    () => ({}),
    (result) => result,
  );
  return {
    name,
    componentPath,
  };
}

async function getDeploymentMetadata(): Promise<DeploymentMetadata> {
  const result = await performAsyncValueSyscall<DeploymentMetadata>(
    ValueSyscall.DeploymentMetadata,
    [],
    () => ({}),
    (result) => jsonToConvexOwned(result) as DeploymentMetadata,
  );
  return {
    name: result.name,
    region: result.region ?? null,
    class: result.class,
  };
}

function getSnapshotTs(): bigint {
  const syscallJSON = performSyscall("1.0/getSnapshotTs", {});
  return jsonToConvexOwned(syscallJSON) as bigint;
}

async function getRequestMetadata(): Promise<RequestMetadata> {
  const { ip, userAgent, requestId, scheduledFunctionId, authToken } =
    await performAsyncValueSyscall<RequestMetadata>(
      ValueSyscall.RequestMetadata,
      [],
      () => ({}),
      (result) => result,
    );
  return { ip, userAgent, requestId, scheduledFunctionId, authToken };
}

export function setupQueryMeta(
  visibility: FunctionMetadata["visibility"],
): QueryMeta {
  return {
    getFunctionMetadata: async () => ({
      ...(await getFunctionMetadata()),
      type: "query",
      visibility,
    }),
    getTransactionMetrics,
    getDeploymentMetadata,
    getSnapshotTs,
  };
}

export function setupMutationMeta(
  visibility: FunctionMetadata["visibility"],
): MutationMeta {
  return {
    getFunctionMetadata: async () => ({
      ...(await getFunctionMetadata()),
      type: "mutation",
      visibility,
    }),
    getTransactionMetrics,
    getDeploymentMetadata,
    getRequestMetadata,
    getSnapshotTs,
  };
}

export function setupActionMeta(
  visibility: FunctionMetadata["visibility"],
): ActionMeta {
  return {
    getFunctionMetadata: async () => ({
      ...(await getFunctionMetadata()),
      type: "action",
      visibility,
    }),
    getDeploymentMetadata,
    getRequestMetadata,
  };
}
