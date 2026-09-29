# Default context reuse during bundling

## Purpose

This patch lets an application configure V8 context reuse in `convex.json`
instead of adding `experimental_reuseContext` exports to individual modules. The
CLI writes the policy into the deployed JavaScript. The
[backend context-reuse patch](https://github.com/convex-in-prod/convex-backend/tree/main/patches/context_reuse)
decides when an initialized context can be retained and used by a later call.

Reuse avoids repeating module initialization. Module variables and imported
package state survive; identity, transactions, and other request state are fresh
for each call. Enable reuse only after checking that a request cannot leave
JavaScript state that changes later requests. Retaining a read-only lookup table
is suitable; retaining the current caller in a module variable is not. Review
the full import graph, including dynamic imports and third-party packages. The
compiler's
[context-reuse analyzer](https://github.com/convex-in-prod/convex-wasm-compiler/tree/main#context-reuse-analysis)
provides source and dependency checks to help with that review.

The setting is absent by default. This example enables reuse for queries,
mutations, HTTP actions, and ordinary actions in two explicitly selected
modules:

```json
{
  "bundler": {
    "experimentalContextReuse": {
      "default": true,
      "httpActions": true,
      "actions": {
        "entries": ["jobs/first.ts", "jobs/second.ts"],
        "grouping": true
      },
      "exclusions": {
        "generated/auth.ts": "The generated authentication graph remains under separate review."
      }
    }
  }
}
```

| Setting             | Effect                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `default: true`     | Enables query and mutation reuse for root-application V8 entry modules, except exclusions.         |
| `httpActions: true` | Also enables HTTP-action reuse. Omission or `false` leaves it disabled.                            |
| `actions.entries`   | Enables ordinary V8-action reuse in these modules. Omission leaves ordinary actions fresh.         |
| `actions.grouping`  | Defaults to `true`. Set it to `false` to keep selected action modules on per-entry initialization. |
| `exclusions`        | Disables reuse for the named entries, with a reason recorded beside each path.                     |

Permissions apply to all exports of the corresponding kind in a module. Paths
are normalized POSIX paths relative to the configured functions directory.
Action entries must be unique and name included root V8 entries; excluded,
missing, and Node.js entries are rejected. Exclusions must also match root V8
entries. Node.js actions use a separate runtime. Imported Convex components keep
their own source policy; schema and authentication configuration bundles are
unchanged. The backend receives each module's emitted policy.

When this setting is enabled, root V8 entries, including excluded entries, must
not also export `experimental_reuseContext`. The CLI rejects conflicting source
markers so the configuration determines the deployed policy.

## Shared initialization groups

Two entry modules that re-export functions from the same shared chunk would
otherwise retain separate copies of that initialized graph. Grouping lets them
share a context. Concurrent calls can still need separate copies, and the
backend's cache and memory limits still apply.

With reuse enabled, the bundler groups entry outputs that contain only imports
and re-exports and have exactly the same ordered static imports of emitted
non-entry chunks. Entries with local initialization, directives, external or
dynamic imports, or different import order keep their existing per-entry policy.
Excluded entries never join a group. Entries with ordinary-action permission
form separate groups from entries without it, so action initialization never
imports entries outside its reviewed permission set. `actions.grouping: false`
keeps selected action entries on per-entry initialization.

For each group of at least two entries, the bundler emits a
`_deps/context_init_<hash>.js` module that statically imports every member. It
is emitted after bundling so those entry dependencies remain visible to backend
read-set capture. Membership, member contents and dependency identities
determine the hash. Each member receives a typed reuse policy with
`initializationModule` pointing to that path; query/mutation reuse and the
configured action and HTTP permissions remain unchanged.

A supporting backend loads every group member before running the first handler.
Before reusing the context, it checks the modules, environment, and other
dependencies read during initialization, including members not previously
called. A later call cannot add a member to the saved group. The requested
function still determines authorization, arguments, and request state. Queries
and mutations share one cache kind; ordinary actions have a separate kind, and
HTTP actions keep per-entry contexts. See the backend's
[grouped initialization contract](https://github.com/convex-in-prod/convex-backend/tree/main/patches/context_reuse#grouped-initialization)
for cache identity and dependency validation.

## Compatibility and safety

Without this setting, existing source-level opt-ins keep their normal behavior.
Ungrouped entries with only query/mutation reuse emit the upstream
`experimental_reuseContext = true` marker. Grouped entries and entries with
ordinary-action or HTTP-action reuse emit an object with separate permissions.
Older backends with typed-policy support ignore `initializationModule` and keep
per-entry reuse. Ordinary upstream backends do not interpret a typed object as
an opt-in and run those entries fresh. Backend grouping support for each UDF
kind must precede the new CLI output to obtain shared contexts. See the
backend's
[policy and propagation reference](https://github.com/convex-in-prod/convex-backend/tree/main/patches/context_reuse/design_reference.md#policy-and-propagation)
for policy encoding and compatibility across backend versions.

The patch adds policy exports and, for grouped entries, an executable
initializer to the deployed graph. Reuse remains opportunistic and all backend
eligibility, UDF-type, cancellation, read-set validation, cache, and
memory-pressure rules continue to apply. The backend checks runtime cleanup and
initialization dependencies; it cannot prove that application globals are safe
to retain. An exclusion leaves the policy export absent and removes the entry
from any generated group, so the entry executes fresh on both patched and
ordinary backends.

## Rollback

For one entry, add an exclusion and redeploy the application. To disable only
HTTP-action reuse, set `httpActions` to false and redeploy the application. To
disable ordinary-action reuse, remove `actions` and redeploy; to retain reuse
with per-entry initialization, set `actions.grouping` to false and redeploy. For
a global rollback of the root application's policy, remove
`bundler.experimentalContextReuse` and every explicit source marker, then
redeploy the complete root application. Imported components keep their own
policy and must be updated separately if they also need reuse disabled.

Once the new policy is deployed, later invocations of the affected modules use
fresh contexts. A worker restart is needed only to discard already retained
contexts immediately, not to make the policy change effective. See the backend's
[adoption and rollback guide](https://github.com/convex-in-prod/convex-backend/tree/main/patches/context_reuse#adoption-and-rollback).
