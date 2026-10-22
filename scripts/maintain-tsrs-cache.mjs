#!/usr/bin/env node
import { resolve } from "node:path";
import { maintainTsrsCache, tsrsCacheRetentionDays } from "./tsrs-cache.mjs";

let apply = false;
let modeSeen = false;
let projectRoot = process.cwd();
let retentionDays = tsrsCacheRetentionDays();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const option = args[index];
  if (option === "--apply" || option === "--dry-run") {
    if (modeSeen)
      throw new Error("Maintenance mode was provided more than once.");
    modeSeen = true;
    apply = option === "--apply";
  } else if (option === "--retention-days" && args[index + 1] !== undefined) {
    retentionDays = tsrsCacheRetentionDays(args[++index]);
  } else if (option === "--project-root" && args[index + 1] !== undefined) {
    projectRoot = resolve(args[++index]);
  } else {
    throw new Error(
      "Usage: maintain-tsrs-cache.mjs [--dry-run|--apply] [--retention-days N] [--project-root PATH]",
    );
  }
}
process.stdout.write(
  `${JSON.stringify(maintainTsrsCache({ projectRoot, retentionDays, apply }), null, 2)}\n`,
);
