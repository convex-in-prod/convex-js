# Convex-In-Prod Patch Stack

The fork's `main` branch carries a short generic patch stack over the exact
upstream commit recorded in `/.convex-in-prod-upstream`.

The stack keeps one commit for each maintained semantic change, followed by one
release-infrastructure commit that owns the upstream marker, complete patch
index, and immutable package workflow. Packaging corrections belong in that
final commit rather than as additional history-only patches.

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

### Local query-result removal observation

`Watch.hasLocalQueryResult()` reports a retained local success or error without
reading or throwing it. `Watch.onLocalQueryResultRemoved()` observes removal
without subscribing to or executing the query. These APIs let applications gate
one-shot retries and resumed subscriptions on the actual sync transition instead
of fixed delays or access to internal client state.

### Default context reuse during bundling

Applications that have reviewed their database-UDF graphs may make the upstream
`experimental_reuseContext` export a bundle-time default and retain a small,
reasoned exclusion map. With a backend that accepts typed context-reuse policy,
the same centralized setting can also enable reviewed HTTP-action graphs while
ordinary actions remain fresh. Both settings are disabled by default and do not
place application module names in backend logic. See
[`default_database_context_reuse/README.md`](default_database_context_reuse/README.md).

### Module-scoped Node pools

Applications may annotate Node modules with a bounded local-pool declaration.
The bundler validates the annotation, emits it in module metadata, and rejects
conflicting declarations within a bundle. Deployments without the annotation
retain the upstream execution model.

### Non-committing codegen analysis

Standalone `convex codegen` requests evaluated component analysis from the
backend's deployment preflight endpoint instead of beginning a multiphase push.
It does not fall back to a mutating request when the backend lacks the matching
analysis response. Development and deployment commands retain the normal push
lifecycle.

This change requires the matching backend patch. Upgrade the backend before
distributing this CLI; roll back the CLI first if codegen must remain available
through a rollback.

## Rebase and release

1. Fetch `upstream` and select an exact reviewed upstream commit.
2. Rebase the semantic commits and update `/.convex-in-prod-upstream` in the
   packaging commit.
3. Use `git range-diff` against the previous stack and run package tests,
   typecheck, format check, and build.
4. Push the maintained `main` branch to `convex-in-prod/convex-js`.
5. Manually dispatch `Build convex-in-prod package` for that exact `main`
   commit.

The workflow appends source-derived SemVer build metadata to the upstream
version, records full source and upstream SHAs in package metadata, and uploads
the tarball for operator publication under the same full SHA at
`https://convex-in-prod.github.io/packages/convex/`. GitHub's npm registry is
not the application distribution boundary because even public packages require
install-time authentication. No Git tag or GitHub Release is required.

Do not encode the fork identity as a SemVer prerelease. Packages that declare an
ordinary `convex@^1.x` peer do not accept prerelease versions even when the fork
remains API-compatible. The immutable artifact URL and provenance fields provide
the source identity without weakening peer-dependency checks.

Applications should pin the exact public tarball URL and lockfile integrity and
never depend on a mutable branch.
