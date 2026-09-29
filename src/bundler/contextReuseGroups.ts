import { createHash } from "node:crypto";
import path from "node:path";
import { parse } from "@babel/parser";
import type { Metafile, OutputFile } from "esbuild";
import type { Context } from "./context.js";

/** Find forwarding entries whose initialization executes the same ordered imports. */
export async function contextReuseGroups(
  ctx: Context,
  outputFiles: OutputFile[],
  metafile: Metafile,
  includedOutputs: ReadonlySet<string>,
  chunksFolder: string,
): Promise<{
  initializers: { path: string; source: string }[];
  initializerByOutput: Map<string, string>;
}> {
  const groups = new Map<string, { path: string; source: string }[]>();
  for (const file of outputFiles) {
    if (!includedOutputs.has(file.path)) continue;
    const outputPath = path
      .relative(process.cwd(), file.path)
      .split(path.sep)
      .join("/");
    const output = metafile.outputs[outputPath];
    if (
      output === undefined ||
      output.imports.length === 0 ||
      output.imports.some(
        (dependency) =>
          dependency.external ||
          dependency.kind !== "import-statement" ||
          metafile.outputs[dependency.path] === undefined ||
          metafile.outputs[dependency.path].entryPoint !== undefined,
      )
    )
      continue;

    const ast = parse(file.text, { sourceType: "module" });
    // Equal dependency sets alone are insufficient: entry-local initialization
    // and a different import order can change observable module state.
    if (
      ast.program.directives.length !== 0 ||
      !ast.program.body.every(
        (statement) =>
          statement.type === "ImportDeclaration" ||
          statement.type === "ExportAllDeclaration" ||
          (statement.type === "ExportNamedDeclaration" &&
            statement.declaration === null) ||
          statement.type === "EmptyStatement",
      )
    )
      continue;

    // Read evaluation order from emitted syntax, rather than depending on the
    // metafile's bookkeeping order. Resolve relative paths so nested entries
    // can share the same group as root entries.
    const imports = ast.program.body.flatMap((statement) =>
      "source" in statement && statement.source
        ? [
            path.posix.normalize(
              path.posix.join(
                path.posix.dirname(outputPath),
                statement.source.value,
              ),
            ),
          ]
        : [],
    );
    const signature = JSON.stringify(imports);
    const members = groups.get(signature) ?? [];
    members.push({
      path: path.relative("out", file.path).split(path.sep).join("/"),
      source: file.text,
    });
    groups.set(signature, members);
  }

  const initializers: { path: string; source: string }[] = [];
  const initializerByOutput = new Map<string, string>();
  for (const [imports, members] of groups) {
    if (members.length < 2) continue;
    members.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // Membership, entry contents, and dependency identities all participate.
    // An exclusion or a changed bundle must not retain the former group key.
    // Leave room for the prefix and `.js` within the backend's 64-byte path
    // component limit. The 48 hex characters retain 192 bits of the digest.
    const hash = createHash("sha256")
      .update(JSON.stringify([imports, members]))
      .digest("hex")
      .slice(0, 48);
    const initializerPath = path.posix.join(
      chunksFolder.split(path.sep).join("/"),
      `context_init_${hash}.js`,
    );
    if (
      metafile.outputs[path.posix.join("out", initializerPath)] !== undefined
    ) {
      return await ctx.crash({
        exitCode: 1,
        errorType: "invalid filesystem data",
        printedMessage: `Context initialization module collides with bundled output: ${initializerPath}`,
      });
    }
    const source = members
      .map((member) => {
        const relativePath = path.posix.relative(
          path.posix.dirname(initializerPath),
          member.path,
        );
        const specifier = relativePath.startsWith(".")
          ? relativePath
          : `./${relativePath}`;
        initializerByOutput.set(
          path.resolve("out", member.path),
          initializerPath,
        );
        return `import ${JSON.stringify(specifier)};\n`;
      })
      .join("");
    // Do not rebundle this module: the entry imports must remain in the deployed
    // graph so the backend captures every member in its initialization read set.
    initializers.push({ path: initializerPath, source });
  }
  return { initializers, initializerByOutput };
}
