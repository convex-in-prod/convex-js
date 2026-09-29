import { z } from "zod";
import type { Context } from "../../../bundler/context.js";

const nativeResidentDescriptor = z
  .object({
    artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
    configurationSha256: z.string().regex(/^[0-9a-f]{64}$/),
    lifecycleProtocol: z.literal(1),
    applicationContract: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  })
  .strict();

export const nativeResidentActivation = z
  .object({
    expectedPrior: nativeResidentDescriptor.nullable(),
    target: nativeResidentDescriptor.nullable(),
    applicationContract: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,128}$/)
      .nullable(),
  })
  .strict()
  .refine(
    (activation) =>
      [activation.expectedPrior, activation.target].every(
        (descriptor) =>
          descriptor === null ||
          descriptor.applicationContract === activation.applicationContract,
      ),
    { message: "Native descriptors require the declared application contract" },
  );

export type NativeResidentActivation = z.infer<typeof nativeResidentActivation>;

export async function readNativeResidentActivation(
  ctx: Context,
  path: string,
): Promise<NativeResidentActivation> {
  const invalidFile = {
    exitCode: 1,
    errorType: "invalid filesystem data" as const,
    printedMessage:
      "The native resident file must contain a valid deployment envelope of at most 16 KiB.",
  };
  try {
    const metadata = ctx.fs.stat(path);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 16 * 1024) {
      return ctx.crash(invalidFile);
    }
    const text = ctx.fs.readUtf8File(path);
    if (Buffer.byteLength(text) > 16 * 1024) return ctx.crash(invalidFile);
    const activation = nativeResidentActivation.parse(JSON.parse(text));
    if (activation.expectedPrior !== null)
      Object.freeze(activation.expectedPrior);
    if (activation.target !== null) Object.freeze(activation.target);
    return Object.freeze(activation);
  } catch {
    // File contents and paths can contain operator credentials. Validation errors stay local.
    return ctx.crash(invalidFile);
  }
}
