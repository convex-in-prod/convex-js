import { Command, Option } from "@commander-js/extra-typings";
import { z } from "zod";
import { oneoffContext } from "../bundler/context.js";
import { logOutput } from "../bundler/log.js";
import {
  deploymentSelectionWithinProjectFromOptions,
  loadSelectedDeploymentCredentials,
} from "./lib/api.js";
import { actionDescription } from "./lib/command.js";
import { getDeploymentSelection } from "./lib/deploymentSelection.js";
import { deploymentFetch, ThrowingFetchError } from "./lib/utils/utils.js";

const modeSchema = z.object({
  primary: z.enum(["v8", "wasm"]),
  shadowBps: z.number().int().min(0).max(10_000),
});
const policySchema = z.object({ query: modeSchema, mutation: modeSchema });
const responseSchema = z.object({
  snapshot: z.object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    policy: policySchema,
  }),
  durable: z.boolean(),
  quarantinedSelectors: z.number().int().nonnegative(),
  quarantineInitialized: z.boolean(),
  preparationElapsedMs: z.number().nonnegative().optional(),
  population: z
    .array(
      z.object({
        group: z.string(),
        target: z.number().int().nonnegative(),
        prepared: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        inProgress: z.number().int().nonnegative(),
        shortfall: z.string().nullable(),
      }),
    )
    .optional(),
});

export const runtimeMode = new Command("runtime-mode")
  .summary("Read or change primary runtime and shadow sampling")
  .description(
    "Select V8 or Wasm primary and opposite-runtime shadow sampling on a supporting self-hosted backend.\n" +
      "With no change options, print the current policy as JSON. Zero shadow percent selects primary only.\n" +
      "Changes persist without deployment or restart. Existing invocations retain their runtime.\n" +
      "Wasm artifacts must already be eligible; this command never clears route quarantines.\n\n" +
      "Examples:\n" +
      "  convex runtime-mode --primary wasm --shadow-percent 5\n" +
      "  convex runtime-mode --primary v8 --shadow-percent 0\n" +
      "  convex runtime-mode --shadow-percent 10 --udf-type query",
  )
  .argument(
    "[operation]",
    'Use "status" to explicitly request the current policy.',
  )
  .addOption(
    new Option(
      "--primary <runtime>",
      "Primary runtime; omit to retain the current selection.",
    ).choices(["v8", "wasm"]),
  )
  .option(
    "--shadow-percent <percent>",
    "Opposite-runtime sampling from 0 to 100, with at most two decimal places; omit to retain it.",
  )
  .addOption(
    new Option(
      "--udf-type <kind>",
      "Apply changes to queries, mutations, or both.",
    )
      .choices(["query", "mutation", "both"])
      .default("both"),
  )
  .addDeploymentSelectionOptions(
    actionDescription("Read or change the runtime policy of"),
  )
  .allowExcessArguments(false)
  .action(async (operation, options) => {
    const ctx = await oneoffContext(options);
    // Ordinary selection consumes direct credentials only as a complete pair.
    // A partial explicit target must not fall back to the configured deployment.
    if ((options.url === undefined) !== (options.adminKey === undefined)) {
      return await ctx.crash({
        exitCode: 1,
        errorType: "fatal",
        printedMessage: "--url and --admin-key must be supplied together.",
      });
    }
    const changing =
      options.primary !== undefined || options.shadowPercent !== undefined;
    if (
      (operation !== undefined && operation !== "status") ||
      (operation === "status" && changing)
    ) {
      return await ctx.crash({
        exitCode: 1,
        errorType: "fatal",
        printedMessage:
          'Use "runtime-mode status" to inspect, or specify --primary and/or --shadow-percent to change the policy.',
      });
    }
    let shadowBps: number | undefined;
    if (options.shadowPercent !== undefined) {
      if (
        !/^\d+(?:\.\d{1,2})?$/.test(options.shadowPercent) ||
        Number(options.shadowPercent) > 100
      ) {
        return await ctx.crash({
          exitCode: 1,
          errorType: "fatal",
          printedMessage:
            "--shadow-percent must be between 0 and 100 with at most two decimal places.",
        });
      }
      shadowBps = Math.round(Number(options.shadowPercent) * 100);
    }
    const selection = await getDeploymentSelection(ctx, options);
    const selectedWithinProject =
      deploymentSelectionWithinProjectFromOptions(options);
    // Ordinary CLI commands may ignore a selector for a deploy key or an
    // anonymous local deployment. A policy update must never address that
    // fallback target when the operator explicitly requested another one.
    if (
      selectedWithinProject.kind !== "unspecified" &&
      (selection.kind === "anonymous" ||
        (selection.kind === "existingDeployment" &&
          selection.deploymentToActOn.source === "deployKey"))
    ) {
      return await ctx.crash({
        exitCode: 1,
        errorType: "fatal",
        printedMessage:
          "The configured deployment cannot resolve this explicit deployment selector. Remove the selector to use the configured deployment, or configure credentials for the intended target.",
      });
    }
    const { url: deploymentUrl, adminKey } =
      await loadSelectedDeploymentCredentials(ctx, selection);
    // A lost POST response may already have committed. Never replay a mode
    // update automatically; the revision prevents overwriting another operator.
    const backendFetch = deploymentFetch(ctx, {
      deploymentUrl,
      adminKey,
      maxRetries: 0,
    });
    const request = async (body?: {
      expectedRevision: number;
      policy: z.infer<typeof policySchema>;
    }) => {
      let response: Response;
      try {
        response = await backendFetch("/api/wasm_runtime_policy", {
          method: body === undefined ? "GET" : "POST",
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          // Primary promotion may use the baseline admission window plus
          // 30 seconds for extra Stores. A lost POST still must not be retried.
          signal: AbortSignal.timeout(body === undefined ? 10_000 : 75_000),
        });
      } catch (error) {
        const status =
          error instanceof ThrowingFetchError
            ? error.response.status
            : undefined;
        // Recognize fixed protocol codes without printing a raw server error
        // or transport URL, which can contain credentials or loader details.
        const reasons: Record<string, string> = {
          WasmRuntimePolicyChanged:
            "The runtime policy changed during this update.",
          SourceKeyedRuntimeExpectedPriorMismatch:
            "The selected source/runtime pair changed during preparation.",
          SourceKeyedRuntimeContentIdentityMissing:
            "The selected runtime pair has no source content identity.",
          StaticHermesWasmGenerationNotStaged:
            "The selected source/runtime pair is not staged.",
          StaticHermesWasmBaselineCapacityUnavailable:
            "Wasm preparation could not establish baseline capacity for every applicable group.",
          StaticHermesWasmGenerationNotReady:
            "The initialized Wasm inventory is no longer available.",
          StaticHermesWasmInitializationChanged:
            "The prepared Wasm initialization dependencies changed.",
          StaticHermesWasmPublicationValidationTimeout:
            "Source or initialization validation timed out before publication.",
          WasmRuntimePolicyStorageRequired:
            "The backend has no durable runtime policy storage.",
        };
        const code =
          error instanceof ThrowingFetchError
            ? error.serverErrorData?.code
            : undefined;
        const reason =
          typeof code === "string" && Object.hasOwn(reasons, code)
            ? reasons[code]
            : undefined;
        return await ctx.crash({
          exitCode: 1,
          errorType: "fatal",
          printedMessage:
            status === 404
              ? "This backend does not support live runtime selection."
              : `${reason ?? `Runtime policy request failed${status === undefined ? "" : ` with HTTP ${status}`}.`} Read runtime-mode status before retrying an update.`,
        });
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return await ctx.crash({
          exitCode: 1,
          errorType: "fatal",
          printedMessage:
            "Backend returned invalid JSON for the runtime policy. Read status before retrying an update.",
        });
      }
      const parsed = responseSchema.safeParse(value);
      if (!parsed.success) {
        return await ctx.crash({
          exitCode: 1,
          errorType: "fatal",
          printedMessage:
            "Backend returned an invalid runtime policy. Read status before retrying an update.",
        });
      }
      return parsed.data;
    };
    let response = await request();
    if (changing) {
      if (!response.durable) {
        return await ctx.crash({
          exitCode: 1,
          errorType: "fatal",
          printedMessage: "Backend has no durable runtime policy storage.",
        });
      }
      const policy = response.snapshot.policy;
      for (const kind of ["query", "mutation"] as const) {
        if (options.udfType !== "both" && options.udfType !== kind) continue;
        policy[kind] = modeSchema.parse({
          primary:
            options.primary === undefined
              ? policy[kind].primary
              : options.primary,
          shadowBps:
            shadowBps === undefined ? policy[kind].shadowBps : shadowBps,
        });
      }
      response = await request({
        expectedRevision: response.snapshot.revision,
        policy,
      });
      for (const kind of ["query", "mutation"] as const) {
        if (
          response.snapshot.policy[kind].primary !== policy[kind].primary ||
          response.snapshot.policy[kind].shadowBps !== policy[kind].shadowBps
        ) {
          return await ctx.crash({
            exitCode: 1,
            errorType: "fatal",
            printedMessage:
              "Backend did not confirm the requested runtime policy. Read status before making another change.",
          });
        }
      }
    }
    logOutput(JSON.stringify(response, null, 2));
  });
