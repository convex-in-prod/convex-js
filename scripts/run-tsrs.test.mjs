import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as tar from "tar";
import { maintainTsrsCache } from "./tsrs-cache.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(repositoryRoot, "scripts/run-tsrs.mjs");
const execute = promisify(execFile);
const source = `export type Box<T> = { value: T };
export const item: Box<string> = { value: "ok" };
/** @internal */
export const hidden = 2;
`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tsrs-build-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    compilerOptions: {
      types: [],
      strict: true,
      skipLibCheck: true,
      declaration: true,
      declarationMap: true,
      emitDeclarationOnly: true,
      stripInternal: true,
      rootDir: "src",
    },
    include: ["src"],
  };
  const checkouts = [join(root, "one"), join(root, "nested", "two")];
  for (const checkout of checkouts) {
    await mkdir(join(checkout, "node_modules"), { recursive: true });
    await symlink(
      join(repositoryRoot, "node_modules/tsrs"),
      join(checkout, "node_modules/tsrs"),
      "dir",
    );
    await mkdir(join(checkout, "src"));
    await writeFile(join(checkout, "src/index.ts"), source);
    await writeFile(
      join(checkout, "src/removed.ts"),
      "export const removed = 1;\n",
    );
    await writeFile(
      join(checkout, "package.json"),
      JSON.stringify({ name: "cache-fixture", type: "module" }),
    );
    await writeFile(join(checkout, "tsconfig.json"), JSON.stringify(config));
  }
  return {
    checkouts,
    config,
    environment: {
      ...process.env,
      TSRS_CACHE_DIR: join(root, "cache"),
      TSRS_CACHE_NAMESPACE: "cache-fixture",
      TSRS_BUILD_DIAGNOSTICS: "1",
      TSRS_DISABLE_BUILD_CACHE: "0",
    },
  };
}

function run(checkout, environment, scope, output) {
  const result = spawnSync(
    process.execPath,
    [runner, scope, ...(output === undefined ? [] : [output])],
    { cwd: checkout, env: environment, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

test("declarations reuse across checkouts, invalidate edits, retain outputs, and separate options", async (t) => {
  const {
    checkouts: [one, two],
    config,
    environment,
  } = await fixture(t);
  assert.match(
    run(one, environment, "public-types", "tmpDistOne"),
    /TSFILE: .*index\.d\.ts\n/u,
  );
  const original = await readFile(
    join(one, "tmpDistOne/esm-types/index.d.ts"),
    "utf8",
  );
  assert.doesNotMatch(original, /hidden/u);
  await rm(join(one, "tmpDistOne"), { recursive: true });
  assert.doesNotMatch(
    run(two, environment, "public-types", "tmpDistTwo"),
    /TSFILE:/u,
  );
  assert.equal(
    await readFile(join(two, "tmpDistTwo/esm-types/index.d.ts"), "utf8"),
    original,
  );
  const mapPath = join(two, "tmpDistTwo/esm-types/index.d.ts.map");
  const map = JSON.parse(await readFile(mapPath, "utf8"));
  assert.equal(
    resolve(dirname(mapPath), map.sourceRoot, map.sources[0]),
    join(two, "src/index.ts"),
  );

  // build.py runs both declaration stages concurrently in one staging parent.
  await Promise.all(
    ["public-types", "internal-types"].map((scope) =>
      execute(process.execPath, [runner, scope, "tmpDistInternal"], {
        cwd: two,
        env: environment,
      }),
    ),
  );
  assert.match(
    await readFile(
      join(two, "tmpDistInternal/internal-esm-types/index.d.ts"),
      "utf8",
    ),
    /hidden/u,
  );
  assert.equal(
    await readFile(join(two, "tmpDistInternal/esm-types/index.d.ts"), "utf8"),
    original,
  );
  assert.doesNotMatch(
    run(two, environment, "public-types", "tmpDistPublicAgain"),
    /TSFILE:/u,
  );
  await writeFile(
    join(two, "src/index.ts"),
    source.replace("Box<string>", "Box<number>").replace('"ok"', "3"),
  );
  await rm(join(two, "src/removed.ts"));
  assert.match(
    run(two, environment, "public-types", "tmpDistEdited"),
    /TSFILE: .*index\.d\.ts\n/u,
  );
  assert.match(
    await readFile(join(two, "tmpDistEdited/esm-types/index.d.ts"), "utf8"),
    /Box<number>/u,
  );
  assert.equal(
    (await readdir(join(two, "tmpDistEdited/esm-types"))).some((name) =>
      name.startsWith("removed."),
    ),
    false,
  );

  config.compilerOptions.stripInternal = false;
  await writeFile(join(two, "tsconfig.json"), JSON.stringify(config));
  run(two, environment, "public-types", "tmpDistConfig");
  assert.match(
    await readFile(join(two, "tmpDistConfig/esm-types/index.d.ts"), "utf8"),
    /hidden/u,
  );
  await writeFile(join(two, "package-lock.json"), '{"lockfileVersion":3}\n');
  assert.match(
    run(two, environment, "public-types", "tmpDistDependencies"),
    /TSFILE: .*index\.d\.ts\n/u,
  );
});

test("typechecks reuse successful work and reject edited errors", async (t) => {
  const {
    checkouts: [one, two],
    environment,
  } = await fixture(t);
  const cold = run(one, environment, "typecheck");
  assert.ok(Number(/Instantiations:\s+(\d+)/u.exec(cold)[1]) > 0);
  const warm = run(two, environment, "typecheck");
  assert.match(warm, /Instantiations:\s+0\n/u);
  const report = maintainTsrsCache({
    projectRoot: one,
    environment,
    retentionDays: 0,
  });
  const archive = join(report.cacheDirectory, report.candidates[0]);
  const original = await readFile(archive);
  // Informational compiler options succeed without creating incremental state.
  const filesOnly = spawnSync(
    process.execPath,
    [runner, "typecheck", "--listFilesOnly"],
    { cwd: two, env: environment, encoding: "utf8" },
  );
  assert.equal(filesOnly.status, 0, filesOnly.stdout + filesOnly.stderr);
  assert.match(filesOnly.stdout, /src[/\\]index\.ts/u);
  await writeFile(join(two, "src/index.ts"), source.replace('"ok"', "3"));
  const failed = spawnSync(process.execPath, [runner, "typecheck"], {
    cwd: two,
    env: environment,
    encoding: "utf8",
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /TS2322/u);
  assert.deepEqual(await readFile(archive), original);
  assert.match(run(one, environment, "typecheck"), /Instantiations:\s+0\n/u);
  assert.equal(
    (await readdir(two)).some((name) => name.startsWith("tmpDistTypecheck-")),
    false,
  );
});

test("uncached typecheck modes forward compiler options without reading or replacing shared state", async (t) => {
  const {
    checkouts: [one],
    environment,
  } = await fixture(t);
  run(one, environment, "typecheck");
  const report = maintainTsrsCache({
    projectRoot: one,
    environment,
    retentionDays: 0,
  });
  const archive = join(report.cacheDirectory, report.candidates[0]);
  await writeFile(archive, "unused corrupt archive");
  const { default: getExePath } =
    await import("../node_modules/tsrs/lib/getExePath.js");
  const modes = [
    { args: [], env: { ...environment, TSRS_DISABLE_BUILD_CACHE: "1" } },
    { args: [], env: { ...environment, TSRS_BINARY: getExePath() } },
    { args: ["--incremental", "false"], env: environment },
  ];
  for (const { args, env } of modes) {
    const result = spawnSync(process.execPath, [runner, "typecheck", ...args], {
      cwd: one,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(Number(/Instantiations:\s+(\d+)/u.exec(result.stdout)[1]) > 0);
    assert.equal(await readFile(archive, "utf8"), "unused corrupt archive");
  }
  await writeFile(join(one, "src/index.ts"), source.replace('"ok"', "3"));
  const failed = spawnSync(
    process.execPath,
    [runner, "typecheck", "--pretty", "false"],
    {
      cwd: one,
      env: environment,
      encoding: "utf8",
    },
  );
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /TS2322/u);
  assert.equal(await readFile(archive, "utf8"), "unused corrupt archive");
});

test("concurrent writers publish coherent declaration archives", async (t) => {
  const {
    checkouts: [one, two],
    environment,
  } = await fixture(t);
  await writeFile(
    join(two, "src/index.ts"),
    source.replace("Box<string>", "Box<number>").replace('"ok"', "3"),
  );
  await Promise.all(
    [one, two].map((cwd) =>
      execute(process.execPath, [runner, "public-types", "tmpDistConcurrent"], {
        cwd,
        env: environment,
      }),
    ),
  );
  for (const [checkout, type] of [
    [one, "string"],
    [two, "number"],
  ]) {
    run(checkout, environment, "public-types", "tmpDistAfterConcurrent");
    assert.match(
      await readFile(
        join(checkout, "tmpDistAfterConcurrent/esm-types/index.d.ts"),
        "utf8",
      ),
      new RegExp(`Box<${type}>`, "u"),
    );
  }
});

test("evicted archives rebuild and an opened archive survives unlink while corruption stays strict", async (t) => {
  const {
    checkouts: [one, two],
    environment,
  } = await fixture(t);
  run(one, environment, "public-types", "tmpDistCold");
  const report = maintainTsrsCache({
    projectRoot: one,
    environment,
    retentionDays: 0,
  });
  assert.equal(report.candidates.length, 1);
  const archive = join(report.cacheDirectory, report.candidates[0]);
  const hook = join(one, "evict-cache.mjs");
  await writeFile(
    hook,
    `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const { readFileSync } = fs;
    fs.readFileSync = function(path, ...args) {
      const bytes = readFileSync(path, ...args);
      if (path === process.env.CACHE_EVICT_PATH) {
        fs.unlinkSync(path);
        fs.writeFileSync(path + ".observed", "evicted");
      }
      return bytes;
    };
    syncBuiltinESMExports();
  `,
  );
  assert.doesNotMatch(
    run(
      two,
      {
        ...environment,
        NODE_OPTIONS: `--import ${JSON.stringify(hook)}`,
        CACHE_EVICT_PATH: archive,
      },
      "public-types",
      "tmpDistEvictedAfterRead",
    ),
    /TSFILE:/u,
  );
  assert.equal(await readFile(archive + ".observed", "utf8"), "evicted");
  const original = await readFile(
    join(one, "tmpDistCold/esm-types/index.d.ts"),
    "utf8",
  );
  assert.equal(
    await readFile(
      join(two, "tmpDistEvictedAfterRead/esm-types/index.d.ts"),
      "utf8",
    ),
    original,
  );
  assert.equal(
    maintainTsrsCache({
      projectRoot: one,
      environment,
      retentionDays: 0,
      apply: true,
    }).removed.files,
    1,
  );
  assert.match(
    run(two, environment, "public-types", "tmpDistEvictedBeforeRead"),
    /TSFILE:/u,
  );
  assert.equal(
    await readFile(
      join(two, "tmpDistEvictedBeforeRead/esm-types/index.d.ts"),
      "utf8",
    ),
    original,
  );
  await writeFile(archive, "corrupt archive");
  const corrupt = spawnSync(
    process.execPath,
    [runner, "public-types", "tmpDistCorrupt"],
    { cwd: one, env: environment, encoding: "utf8" },
  );
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /TAR_BAD_ARCHIVE/u);
});

test("archived build info requires pruning paths and leaves incremental recovery to tsrs", async (t) => {
  const {
    checkouts: [one, two],
    environment,
  } = await fixture(t);
  run(one, environment, "public-types", "tmpDistCold");
  const report = maintainTsrsCache({
    projectRoot: one,
    environment,
    retentionDays: 0,
  });
  const archive = join(report.cacheDirectory, report.candidates[0]);
  const original = await readFile(archive);
  const snapshot = join(one, "snapshot");
  for (const [index, corruption] of [
    "invalid-json",
    "invalid-shape",
    "invalid-file-name",
    "missing-build-info",
  ].entries()) {
    await mkdir(snapshot);
    await writeFile(archive, original);
    await tar.x({ file: archive, cwd: snapshot });
    const buildInfo = join(snapshot, "public-types.tsbuildinfo");
    if (corruption === "invalid-json") await writeFile(buildInfo, "invalid");
    if (corruption === "invalid-shape") await writeFile(buildInfo, "{}");
    if (corruption === "invalid-file-name") {
      const info = JSON.parse(await readFile(buildInfo, "utf8"));
      info.fileNames[0] = null;
      await writeFile(buildInfo, JSON.stringify(info));
    }
    if (corruption === "missing-build-info") await rm(buildInfo);
    await tar.c(
      { file: archive, cwd: snapshot, gzip: true },
      await readdir(snapshot),
    );
    const damaged = await readFile(archive);
    const result = spawnSync(
      process.execPath,
      [runner, "public-types", `tmpDistCorrupt${index}`],
      {
        cwd: two,
        env: environment,
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0, corruption);
    assert.equal(result.stdout, "", corruption);
    assert.deepEqual(await readFile(archive), damaged, corruption);
    await rm(snapshot, { recursive: true });
  }

  await mkdir(snapshot);
  await writeFile(archive, original);
  await tar.x({ file: archive, cwd: snapshot });
  const buildInfo = join(snapshot, "public-types.tsbuildinfo");
  const { fileNames } = JSON.parse(await readFile(buildInfo, "utf8"));
  // Pruning paths remain usable even when tsrs must rebuild its private state.
  await writeFile(buildInfo, JSON.stringify({ fileNames }));
  await tar.c(
    { file: archive, cwd: snapshot, gzip: true },
    await readdir(snapshot),
  );
  assert.match(
    run(two, environment, "public-types", "tmpDistRecovered"),
    /TSFILE: .*index\.d\.ts\n/u,
  );
  assert.equal(
    await readFile(join(two, "tmpDistRecovered/esm-types/index.d.ts"), "utf8"),
    await readFile(join(one, "tmpDistCold/esm-types/index.d.ts"), "utf8"),
  );
});
