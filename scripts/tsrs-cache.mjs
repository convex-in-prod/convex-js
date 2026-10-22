import { lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export function projectTsrsCacheRoot(projectRoot, environment = process.env) {
  let cacheRoot = environment.TSRS_CACHE_DIR;
  if (cacheRoot === undefined) {
    const cacheHome =
      environment.XDG_CACHE_HOME ??
      (process.platform === "darwin"
        ? join(homedir(), "Library", "Caches")
        : join(homedir(), ".cache"));
    if (cacheHome === "")
      throw new Error("Compiler cache paths must not be empty.");
    cacheRoot = join(cacheHome, "tsrs");
  }
  if (cacheRoot === "")
    throw new Error("Compiler cache paths must not be empty.");
  const packageJson = JSON.parse(
    readFileSync(join(projectRoot, "package.json"), "utf8"),
  );
  if (
    packageJson === null ||
    typeof packageJson !== "object" ||
    Array.isArray(packageJson)
  ) {
    throw new Error("The project package manifest must be an object.");
  }
  if (packageJson.name !== undefined && typeof packageJson.name !== "string") {
    throw new Error("The project package name must be a string when provided.");
  }
  const namespace =
    environment.TSRS_CACHE_NAMESPACE ??
    (packageJson.name ?? "project")
      .replace(/^@/u, "")
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,213}$/u.test(namespace)) {
    throw new Error("TSRS_CACHE_NAMESPACE must be a simple non-empty name.");
  }
  return resolve(cacheRoot, namespace);
}

export function tsrsCacheRetentionDays(
  value = process.env.TSRS_CACHE_RETENTION_DAYS ?? 30,
) {
  const days = Number(value);
  if (
    value === "" ||
    !Number.isFinite(days) ||
    days < 0 ||
    !Number.isSafeInteger(days * 86_400_000)
  ) {
    throw new Error(
      "TSRS cache retention days must be a non-negative duration in whole milliseconds.",
    );
  }
  return days;
}

export function maintainTsrsCache({
  projectRoot,
  environment = process.env,
  retentionDays = tsrsCacheRetentionDays(
    environment.TSRS_CACHE_RETENTION_DAYS ?? 30,
  ),
  apply = false,
  now = Date.now(),
}) {
  const cacheDirectory = projectTsrsCacheRoot(projectRoot, environment);
  retentionDays = tsrsCacheRetentionDays(retentionDays);
  if (!Number.isSafeInteger(now))
    throw new Error(
      "TSRS cache maintenance requires a whole-millisecond timestamp.",
    );
  const cutoff =
    (BigInt(now) - BigInt(retentionDays * 86_400_000)) * 1_000_000n;
  const report = {
    cacheDirectory,
    apply,
    retentionDays,
    completed: { files: 0, bytes: 0 },
    eligible: { files: 0, bytes: 0 },
    removed: { files: 0, estimatedBytes: 0 },
    preserved: { files: 0, bytes: 0, directories: 0 },
    changedOrMissing: 0,
    candidates: [],
  };
  for (const path of [dirname(cacheDirectory), cacheDirectory]) {
    const state = lstatSync(path, { throwIfNoEntry: false });
    if (state === undefined) return report;
    if (
      !state.isDirectory() ||
      (typeof process.getuid === "function" && state.uid !== process.getuid())
    ) {
      throw new Error(
        "The tsrs cache root and project cache must be real owned directories.",
      );
    }
  }
  const archives = join(cacheDirectory, "declarations-v1");
  const archiveState = lstatSync(archives, { throwIfNoEntry: false });
  if (archiveState === undefined || !archiveState.isDirectory()) return report;

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const state = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (state === undefined) {
        report.changedOrMissing += 1;
        continue;
      }
      if (state.isDirectory()) {
        report.preserved.directories += 1;
        if (!entry.name.endsWith(".tmp")) walk(path);
        continue;
      }
      const localPath = relative(cacheDirectory, path).split(sep).join("/");
      if (
        !/^declarations-v1\/[^/]+\/[a-z0-9]+-[a-z0-9_]+-[0-9a-f]{64}\/(?:public-types|internal-types|typecheck)\.tgz$/u.test(
          localPath,
        ) ||
        !state.isFile() ||
        state.nlink !== 1n ||
        (typeof process.getuid === "function" &&
          state.uid !== BigInt(process.getuid()))
      ) {
        report.preserved.files += 1;
        report.preserved.bytes += Number(state.size);
        continue;
      }
      report.completed.files += 1;
      report.completed.bytes += Number(state.size);
      if (state.mtimeNs > cutoff) continue;
      report.eligible.files += 1;
      report.eligible.bytes += Number(state.size);
      report.candidates.push(localPath);
      if (!apply) continue;
      const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (
        current === undefined ||
        current.dev !== state.dev ||
        current.ino !== state.ino ||
        current.size !== state.size ||
        current.mtimeNs !== state.mtimeNs ||
        current.ctimeNs !== state.ctimeNs
      ) {
        report.changedOrMissing += 1;
        continue;
      }
      try {
        // Replacement between this check and unlink can also evict a completed entry. Readers
        // retain archive bytes from one open, and every parent and publication file remains.
        unlinkSync(path);
        report.removed.files += 1;
        report.removed.estimatedBytes += Number(state.size);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        report.changedOrMissing += 1;
      }
    }
  }
  walk(archives);
  return report;
}
