# Convex-In-Prod Patch Stack

The fork's `main` branch carries a short generic patch stack over the exact
upstream commit recorded in `/.convex-in-prod-upstream`.

The stack keeps each adoption contract in one source commit. Release tooling
owns the upstream marker, patch index and immutable package build workflow.
Archive publication belongs to `convex-in-prod.github.io`; source history and
generated patch-history contain no package archives.

The commits are the source authority. Applications consume an immutable package
produced from one exact commit; they do not install this Git branch or rewrite
installed Convex files.

Backend patches and the backend sides of cross-repository contracts are indexed
in the
[`convex-backend` maintained patch set](https://github.com/convex-in-prod/convex-backend/blob/main/patches/README.md).

## Maintained changes

### Typed completed HTTP failures

`ConvexHttpClient` throws `ConvexHttpError` for a completed non-UDF HTTP
failure. The error retains the HTTP status and response text, plus the parsed
response body when the response declares valid JSON. Transport failures and
incomplete response bodies remain ordinary transport errors because they do not
provide a completed server result. This lets downstream consumers distinguish
explicit server rejection from an ambiguous request outcome without parsing
error messages or intercepting the client's fetch implementation.

The error also exposes `executionStatus = "rejected_before_execution"` for a
completed JSON HTTP 503 whose exact short code is emitted by the backend's
`ErrorCode::RejectedBeforeExecution` paths. The backend currently omits that
semantic category from HTTP JSON, so the client maintains the compatibility set
from `RejectedBeforeExecutionReason::error_metadata` in
`crates/isolate/src/metrics.rs`. When rebasing, review every set member for
exclusive use by rejected-before-execution paths and add new backend members
only after that review. Missing a new member fails closed; status, response
text, malformed JSON, and unknown short codes never grant this classification.

### Terminal OCC mutation retry

The client and action context retry a mutation once after a terminal
optimistic-concurrency failure, waiting two seconds by default. Callers can
change the count and delay or disable the outer retry. HTTP retries require a
completed JSON HTTP 503 with exact code `OptimisticConcurrencyControlFailure`
and a string message. Transport loss, timeouts, incomplete bodies, UDF errors
and matching text alone never authorize replay. Action-context callbacks retain
their existing internal/public terminal-conflict message classifier.

This change is derived from
[get-convex/convex-js PR 170](https://github.com/get-convex/convex-js/pull/170).
Remove the local commit when upstream contains equivalent behavior.

### Degradable reactive-query pressure

A sync client may opt its root reactive queries into the closed `"degradable"`
workload class and negotiate lifecycle version 1. The client strictly parses
legacy, active, and cleared server-pressure metadata after applying each
transition, tracks the current connection-local epoch, and exposes one
epoch-scoped deferred-query retry request. Invalid retry epochs fail before a
wire message is sent, and duplicate or stale retries do not send. Mutations and
actions remain normal. Application callback failures are contained so they
cannot interrupt synchronization.

This wire extension requires matching backend support. It remains inert unless
the application opts in and the backend enables degradable leader admission.
Lifecycle-capable applications keep successful subscriptions mounted and use a
matching cleared event as the recovery boundary; the backend owns the exact
deferred query set.

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

### Stateless UTF-8 value comparison

UTF-8 value comparison keeps all request-derived comparison state local to the
invocation. It preserves the established ordering for well-formed strings and
lone UTF-16 surrogates without module-scoped scratch arrays. This allows a
reviewed reusable database-function module context to retain the comparator code
without retaining bytes derived from an earlier request.

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

### Per-call HTTP mutation priority

`ConvexHttpClient.mutation` accepts `priority: "normal" | "high"` per call. The
option survives queued execution and each definitive OCC retry; invalid values
fail before sending. It does not reorder the local queue. Independent callers
can combine it with `skipQueue`. The matching backend advertises
`mutationPriorityProtocol: 1` when lane-aware admission is enabled. High
mutations receive bounded preference inside existing capacity and platform
barriers.

### Native resident publication and ownership metadata

`convex deploy --native-resident <file>` validates and freezes a protocol-1
publication envelope before build commands. It requires explicit nullable
`expectedPrior`, `target` and `applicationContract` fields and matching backend
capability. Deployment metadata exposes the committed `nativeResident`
descriptor or null; an older backend's omission becomes null and grants no
native ownership. The backend owns process preparation, transactional selection
and lifecycle cleanup. See the
[backend native resident contract](https://github.com/convex-in-prod/convex-backend/blob/main/crates/node_executor/NATIVE_RESIDENTS.md).

### Bounded Node resident retirement

Node modules can register a retirement callback and observe its fixed drain
deadline. The matching local executor closes old admission and supervises
cleanup; the callback does not override forced termination or memory-pressure
authority.

### Typed runtime value boundary

A supporting runtime can provide bulk query collection, owned JSON values and
typed syscall arguments/results. The SDK retains the ordinary serialized
boundary when those capabilities are absent. This is one runtime integration
patch, including value ownership tests and query, database, metadata, storage
and registration adapters.

## Rebase and release

1. Select an exact reviewed upstream commit and update
   `/.convex-in-prod-upstream` with the source stack.
2. Preserve existing source refs and immutable package artifacts before
   rewriting the semantic commits. Regenerate patch-history and verify its
   result tree.
3. Run relevant tests, typecheck, format checks and the package build when
   source changes require them.
4. Push the maintained source and patch-history branches.
5. For a new public archive, manually dispatch `Build convex-in-prod package` at
   the exact reviewed source commit and verify the downloaded archive's
   provenance, version, SHA-512 checksum and lockfile integrity.
6. Add that immutable archive and manifest to
   `convex-in-prod.github.io/public/packages/convex/<full-source-sha>/` in the
   distribution repository, then publish its normal Pages workflow.

The workflow appends source-derived SemVer build metadata to the upstream
version and records full source and upstream SHAs in package metadata. The
public URL remains
`https://convex-in-prod.github.io/packages/convex/<source-sha>/convex.tgz`.
Existing directories and manifests must never be overwritten or rebuilt in
place. The distribution repository owns those bytes; this source repository owns
the code and build workflow. No Git tag or GitHub Release is required for a new
package.

Do not encode the fork identity as a SemVer prerelease: ordinary `convex@^1.x`
peers do not accept prerelease versions. Applications should pin the immutable
public tarball URL and lockfile integrity, never a mutable source branch.
