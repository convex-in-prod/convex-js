import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import * as tar from "tar";
import { projectTsrsCacheRoot } from "./tsrs-cache.mjs";

const root = process.cwd();
const [scope, ...argumentsList] = process.argv.slice(2);
const outputName = {
  "public-types": "esm-types",
  "internal-types": "internal-esm-types",
}[scope];
if (scope !== "typecheck" && outputName === undefined) {
  throw new Error(
    "Usage: run-tsrs.mjs typecheck [compiler options] | (public-types|internal-types) <temporary directory>",
  );
}
const ownsTemporaryDirectory = scope === "typecheck";
if (!ownsTemporaryDirectory && argumentsList.length !== 1) {
  throw new Error("Declaration staging requires one temporary directory.");
}
const require = createRequire(join(root, "package.json"));
const compilerPackagePath = require.resolve("tsrs/package.json");
const compilerPackage = JSON.parse(readFileSync(compilerPackagePath, "utf8"));
const compiler = join(dirname(compilerPackagePath), compilerPackage.bin.tsrs);
const outputParent = ownsTemporaryDirectory
  ? mkdtempSync(join(root, "tmpDistTypecheck-"))
  : resolve(root, argumentsList[0]);
// Source paths in build info and declaration maps are relative. Every staging directory has
// the same depth as dist, including after moving the archive to another checkout.
if (dirname(outputParent) !== root) {
  throw new Error(
    "Declaration staging requires one directory directly inside the package root.",
  );
}
mkdirSync(outputParent, { recursive: true });
const buildInfoName = `${scope}.tsbuildinfo`;
const buildInfoPath = join(outputParent, buildInfoName);
const compilerArgs = [
  "--incremental",
  "--tsBuildInfoFile",
  buildInfoPath,
  ...(ownsTemporaryDirectory
    ? ["--noEmit", "--emitDeclarationOnly", "false", ...argumentsList]
    : [
        "--outDir",
        join(outputParent, outputName),
        ...(scope === "internal-types" ? ["--stripInternal", "false"] : []),
      ]),
  ...(process.env.TSRS_BUILD_DIAGNOSTICS === "1"
    ? ["--extendedDiagnostics", "--listEmittedFiles"]
    : []),
];
const useSharedCache =
  process.env.TSRS_BINARY === undefined &&
  process.env.TSRS_DISABLE_BUILD_CACHE !== "1" &&
  (!ownsTemporaryDirectory || argumentsList.length === 0);

function sharedArchivePath() {
  const hash = createHash("sha256").update("declarations-v1\0");
  // Source edits stay in the same entry: the compiler owns ordinary incremental invalidation.
  for (const name of [
    "package.json",
    "tsconfig.json",
    "package-lock.json",
    "node_modules/.package-lock.json",
  ]) {
    hash.update(name).update("\0");
    try {
      hash.update(readFileSync(join(root, name)));
    } catch (error) {
      if (error.code !== "ENOENT" || !name.endsWith("package-lock.json"))
        throw error;
      hash.update("missing");
    }
    hash.update("\0");
  }
  return join(
    projectTsrsCacheRoot(root),
    "declarations-v1",
    compilerPackage.version,
    `${process.platform}-${process.arch}-${hash.digest("hex")}`,
    `${scope}.tgz`,
  );
}

function readBuildInfo() {
  const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8"));
  // Pruning consumes fileNames; tsrs owns validation and recovery of its private state.
  if (
    !Array.isArray(buildInfo?.fileNames) ||
    !buildInfo.fileNames.every(
      (name) => typeof name === "string" && name.length > 0,
    )
  ) {
    throw new Error("The tsrs cache build info contains unusable fileNames.");
  }
  return buildInfo;
}

function pruneRemovedDeclarations(directory, programPaths) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      pruneRemovedDeclarations(path, programPaths);
    } else if (/\.d\.(?:ts|mts|cts)\.map$/u.test(entry.name)) {
      const map = JSON.parse(readFileSync(path, "utf8"));
      if (
        !map.sources.every((source) =>
          programPaths.has(resolve(dirname(path), map.sourceRoot, source)),
        )
      ) {
        rmSync(path);
        rmSync(path.slice(0, -4));
      }
    }
  }
}

let temporaryArchive;
try {
  const archive = useSharedCache ? sharedArchivePath() : undefined;
  if (archive !== undefined) {
    let archiveBytes;
    try {
      // Retain bytes from one open: maintenance can unlink this completed archive at any time.
      archiveBytes = readFileSync(archive);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (archiveBytes !== undefined) {
      // A single archive publishes build info and all emitted files together. Each invocation
      // extracts into its own staging directory; competing writers atomically replace the archive.
      await new Promise((resolve, reject) => {
        const unpack = tar.x({ cwd: outputParent, strict: true });
        unpack.on("error", reject);
        unpack.on("close", resolve);
        unpack.end(archiveBytes);
      });
      // Missing build info, malformed JSON, and unusable pruning paths fail here.
      // The compiler may rebuild when the remaining incremental state is unusable.
      readBuildInfo();
    }
  }

  const result = spawnSync(process.execPath, [compiler, ...compilerArgs], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) process.kill(process.pid, result.signal);
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  } else if (archive !== undefined || outputName !== undefined) {
    // Extra typecheck options can request only file listings or help, without build info.
    // Only cached checks and declaration emission require incremental state after success.
    const buildInfo = readBuildInfo();
    if (outputName !== undefined) {
      pruneRemovedDeclarations(
        join(outputParent, outputName),
        new Set(buildInfo.fileNames.map((name) => resolve(outputParent, name))),
      );
    }
    if (archive !== undefined) {
      mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
      temporaryArchive = `${archive}.${randomUUID()}.tmp`;
      await tar.c(
        {
          file: temporaryArchive,
          cwd: outputParent,
          gzip: true,
          portable: true,
        },
        [buildInfoName, ...(outputName === undefined ? [] : [outputName])],
      );
      chmodSync(temporaryArchive, 0o600);
      renameSync(temporaryArchive, archive);
    }
  }
} finally {
  if (temporaryArchive !== undefined) rmSync(temporaryArchive, { force: true });
  rmSync(buildInfoPath, { force: true });
  if (ownsTemporaryDirectory)
    rmSync(outputParent, { recursive: true, force: true });
}
