# Contributing

Thanks for your interest in contributing to convex-js.

For anything not covered here, feel free to ask in the
[Convex Discord Community](https://convex.dev/community).

### I have a question

Great, please use GitHub discussions for this, or ask in Discord.

## I have a feature suggestion

Great, please open a GitHub issue on this repository for this or share in
Discord.

### I want to make a pull request

convex-js is developed primarily by employees of Convex Inc. We're excited to
provide transparency to our customers and contribute to the community by
releasing this code. We can accept some pull requests from non-employee
contributors, but please check in on Discord or in GitHub issues before getting
into anything more than small fixes to see if it's consistent with our short
term plan. We think carefully about how our APIs contribute to a cohesive
product, so chatting up front goes a long way.

Client tests can be run with

```
npm test
```

but be aware that there are integration tests, end-to-end tests, proptests, and
more which test this code but are not located in this repository.

# Directory structure notes

Code generally lives in the src/ directory.

The nearly-empty directories for each entry point at the top level implement the
'package-json-redirects' strategy described at
https://github.com/andrewbranch/example-subpath-exports-ts-compat in an effort
to make the convex npm package as compatible as possible while making the
published package mirror the filesystem of this repository.

# Build notes

management-api.json is a programmatically updated file that generates
src/cli/generatedApi.ts, but generating this file is a manual process. Run
`npm run generateManagementApiSpec` to update it.

`npm run typecheck` and the declaration stages of `npm run build` use
incremental tsrs builds through `scripts/run-tsrs.mjs`. Their shared cache root
is `TSRS_CACHE_DIR`, defaulting to `tsrs` under `XDG_CACHE_HOME` or the platform
user cache directory. The package name supplies the project namespace;
`TSRS_CACHE_NAMESPACE` overrides it. Compiler release, platform, dependency
locks, TypeScript configuration, and public/internal/typecheck options separate
entries. Ordinary source edits keep the same entry and use the compiler's
invalidation.

Declaration entries are atomic archives containing both build info and emitted
declarations. Each build restores into its own `tmpDist*` directory at the same
depth as `dist`, preserving build-info and declaration-map relative paths across
checkouts. Removed source declarations are pruned before publication. Public and
internal output stay separate, and a successful build replaces one archive per
variant; concurrent writers never publish mixed build info and outputs. Deleting
`dist` does not discard reusable declarations. Failed builds do not publish.

`TSRS_BUILD_DIAGNOSTICS=1` reports compiler reuse diagnostics.
`TSRS_DISABLE_BUILD_CACHE=1`, `TSRS_BINARY`, or extra typecheck arguments
disable shared-cache reads and publication. `npm run test:build-cache` checks
real warm reuse, invalidation, relocation, output availability, and concurrent
writers. These CLI caches do not provide persisted semantic snapshots to the
tsrs API.

The runner removes its temporary archive and typecheck directories on
completion; `npm run clean` removes package build staging directories.
`npm run cache:tsrs:prune -- --dry-run` reports completed declaration archives
older than 30 days in the selected project namespace. `--apply` removes those
archives. `--retention-days N` or `TSRS_CACHE_RETENTION_DAYS` changes the
retention interval; `--project-root PATH` selects another package manifest. The
command uses modification time at publication, with no access-time writes or
per-pass limit. All directories, writer temporary files, unknown formats,
source/output trees, and other project namespaces remain untouched. Readers
retain archive bytes from one open; eviction before that open is a cache miss.
Malformed archives, missing build info, invalid build-info JSON, and unusable
`fileNames` fail explicitly. The runner uses `fileNames` to prune declarations;
tsrs owns the remaining incremental-state validation and may rebuild when that
state is unusable. Maintenance is owned by this SDK and requires only Node,
independently of consumer application checkouts.

CI runners reuse entries across jobs only when their cache mechanism restores
this directory; otherwise reuse lasts for the job.
