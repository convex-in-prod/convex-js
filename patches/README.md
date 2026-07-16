# Convex-In-Prod Patch Stack

The fork's `main` branch carries a short generic patch stack over the exact
upstream commit recorded in `/.convex-in-prod-upstream`.

The commits are the source authority. Applications consume an immutable package
produced from one exact commit; they do not install this Git branch or rewrite
installed Convex files.

## Maintained changes

### Terminal OCC mutation retry

The client and action context retry a mutation once after a terminal
optimistic-concurrency failure, waiting two seconds by default. Callers can
change the count and delay or disable the outer retry. The matcher accepts both
the internal error name and Convex's public terminal-conflict text.

This change is derived from
[get-convex/convex-js PR 170](https://github.com/get-convex/convex-js/pull/170).
Remove the local commit when upstream contains equivalent behavior.

### Degradable reactive-query pressure

A sync client may opt its root reactive queries into the closed `"degradable"`
workload class and receive bounded server-pressure metadata after applying a
transition. Mutations and actions remain normal. Application callback failures
are contained so they cannot interrupt synchronization.

This wire extension requires matching backend support. It remains inert unless
the application opts in and the backend enables degradable leader admission.

## Rebase and release

1. Fetch `upstream` and select an exact reviewed upstream commit.
2. Rebase the semantic commits and update `/.convex-in-prod-upstream` in the
   packaging commit.
3. Use `git range-diff` against the previous stack and run package tests,
   typecheck, format check, and build.
4. Push the maintained `main` branch to `convex-in-prod/convex-js`.
5. Manually dispatch `Build convex-in-prod package` for that exact `main`
   commit.

The workflow derives the package version from the upstream version and source
SHA, records full source and upstream SHAs in package metadata, and uploads the
tarball for operator publication under the same full SHA at
`https://convex-in-prod.github.io/packages/convex/`. GitHub's npm registry is
not the application distribution boundary because even public packages require
install-time authentication. No Git tag or GitHub Release is required.

Applications should pin the exact public tarball URL and lockfile integrity and
never depend on a mutable branch.
