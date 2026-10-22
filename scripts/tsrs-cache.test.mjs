import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { maintainTsrsCache, projectTsrsCacheRoot } from "./tsrs-cache.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tsrs-maintenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, "package.json"), '{"name":"cache-fixture"}');
  const environment = { TSRS_CACHE_DIR: join(root, "cache") };
  return {
    projectRoot,
    environment,
    cache: projectTsrsCacheRoot(projectRoot, environment),
  };
}

test("SDK maintenance preserves readers, writer paths, other projects, and unknown entries", (t) => {
  const { projectRoot, environment, cache } = fixture(t);
  const key = `declarations-v1/0.18.0/linux-x64-${"a".repeat(64)}`;
  function publish(path, ageDays) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.writer.tmp`, "complete");
    renameSync(`${path}.writer.tmp`, path);
    const time = new Date(Date.now() - ageDays * 86_400_000);
    utimesSync(path, time, time);
    return path;
  }
  const old = publish(join(cache, key, "public-types.tgz"), 40);
  const kept = [
    publish(join(cache, key, "internal-types.tgz"), 2),
    publish(join(cache, key, "public-types.tgz.writer.tmp"), 40),
    publish(join(cache, key, "unknown.tgz"), 40),
    publish(join(cache, "future-format/entry.tgz"), 40),
    publish(join(dirname(cache), "other-project", key, "public-types.tgz"), 40),
    publish(join(projectRoot, "src/index.ts"), 40),
    publish(join(projectRoot, "dist/index.d.ts"), 40),
  ];
  const link = join(
    cache,
    `declarations-v1/0.18.0/linux-x64-${"b".repeat(64)}`,
    "typecheck.tgz",
  );
  mkdirSync(dirname(link));
  symlinkSync(kept[5], link);
  kept.push(link);
  const hardlink = join(cache, key, "typecheck.tgz");
  linkSync(kept[5], hardlink);
  kept.push(hardlink);
  // Recently read completed entries still expire by modification time.
  utimesSync(old, new Date(), statSync(old).mtime);
  const reader = openSync(old, "r");
  t.after(() => closeSync(reader));
  const dry = maintainTsrsCache({ projectRoot, environment });
  assert.equal(dry.retentionDays, 30);
  assert.equal(dry.eligible.files, 1);
  assert.equal(dry.eligible.bytes, Buffer.byteLength("complete"));
  assert.equal(dry.removed.files, 0);
  assert.ok(existsSync(old));
  const applied = spawnSync(
    process.execPath,
    [
      join(repositoryRoot, "scripts/maintain-tsrs-cache.mjs"),
      "--apply",
      "--project-root",
      projectRoot,
    ],
    {
      env: {
        ...process.env,
        ...environment,
        TSRS_CACHE_NAMESPACE: "cache-fixture",
        TSRS_CACHE_RETENTION_DAYS: "30",
      },
      encoding: "utf8",
    },
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).removed.files, 1);
  assert.equal(
    JSON.parse(applied.stdout).removed.estimatedBytes,
    Buffer.byteLength("complete"),
  );
  assert.equal(existsSync(old), false);
  assert.equal(readFileSync(reader, "utf8"), "complete");
  for (const path of kept) assert.ok(existsSync(path), path);
  assert.ok(statSync(dirname(old)).isDirectory());
  renameSync(kept[1], old);
  assert.equal(readFileSync(old, "utf8"), "complete");
  assert.equal(
    maintainTsrsCache({ projectRoot, environment, retentionDays: 1 }).eligible
      .files,
    2,
  );
});

test("SDK cache namespaces support npm names, unnamed projects, and explicit roots with empty XDG", (t) => {
  const { projectRoot, environment } = fixture(t);
  const manifest = join(projectRoot, "package.json");
  writeFileSync(manifest, JSON.stringify({ name: "x".repeat(214) }));
  assert.equal(
    projectTsrsCacheRoot(projectRoot, { ...environment, XDG_CACHE_HOME: "" }),
    join(environment.TSRS_CACHE_DIR, "x".repeat(214)),
  );
  writeFileSync(manifest, "{}");
  assert.equal(
    projectTsrsCacheRoot(projectRoot, environment),
    join(environment.TSRS_CACHE_DIR, "project"),
  );
  for (const value of [null, [], { name: 5 }]) {
    writeFileSync(manifest, JSON.stringify(value));
    assert.throws(
      () => projectTsrsCacheRoot(projectRoot, environment),
      /manifest|package name/u,
    );
  }
});
