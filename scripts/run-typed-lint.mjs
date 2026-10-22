import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const oxlint = join(
  dirname(require.resolve("oxlint/package.json")),
  "bin/oxlint",
);
const tsrsLint =
  process.platform === "win32"
    ? join(root, "node_modules/.bin/tsrs-lint.cmd")
    : join(dirname(require.resolve("tsrs/package.json")), "bin/tsrs-lint");
// Resolve the packaged launcher directly, including nested installs. This also
// avoids shell-specific environment assignments in the npm script.
const result = spawnSync(
  process.execPath,
  [oxlint, "--type-aware", "--type-check", "--disable-nested-config", "src"],
  {
    cwd: root,
    env: { ...process.env, OXLINT_TSGOLINT_PATH: tsrsLint },
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
if (result.signal) {
  throw new Error(`Typed lint terminated by ${result.signal}`);
}
if (result.status === null)
  throw new Error("Typed lint returned no exit status");
process.exitCode = result.status;
