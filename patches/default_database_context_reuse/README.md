# Default context reuse during bundling

## Purpose

Upstream Convex enables reusable database-UDF contexts one entry module at a
time through `experimental_reuseContext = true`. A backend with typed
context-reuse policy can additionally allow ordinary or HTTP actions. These are
useful canary interfaces, but they become repetitive when an application has
reviewed its entry graphs and wants reuse to be the normal policy.

This patch adds one disabled-by-default Convex CLI setting:

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

For entries without a shared initialization group or ordinary-action permission,
when `httpActions` is absent or false, the isolate bundler adds the ordinary
upstream `experimental_reuseContext = true` export to every root-application
isolate entry output except the listed paths. When `httpActions` is true, it
instead emits one typed policy that enables queries, mutations, and HTTP
actions. The optional `actions.entries` list independently enables ordinary
isolate actions for those reviewed entry graphs. Omission keeps ordinary actions
fresh. Paths must be unique normalized POSIX paths relative to the configured
functions directory and name included root isolate entries; excluded, missing,
and Node entries are rejected. Paths are relative to the configured functions
directory. Imported Convex components retain their own source policy. The
backend receives no application module allowlist. Node entry modules, schema
bundles, and auth configuration bundles are unchanged.

The reason strings keep exceptional modules and their operator rationale
together. Application tooling should verify that exclusions still name
database-UDF entries; the CLI additionally rejects an exclusion that does not
match a root isolate entry. Applications should review the full runtime import
graph before enabling the default. The CLI setting is not a substitute for that
source and emitted-bundle review.

## Shared initialization groups

Under the same opt-in, the bundler groups enabled entry outputs that contain
only imports and re-exports and have exactly the same ordered static imports of
emitted non-entry chunks. Entries with local initialization, directives,
external or dynamic imports, or different import order keep their existing
per-entry policy. Excluded entries never join a group. Entries with
ordinary-action permission form separate groups from entries without it, so
action initialization never imports entries outside its reviewed permission set.
`actions.grouping` defaults to true; false keeps selected action entries on
per-entry initialization. This does not introduce manual group lists or
approximate dependency matching.

For each group of at least two entries, the bundler emits a
`_deps/context_init_<hash>.js` module that statically imports every member. It
is emitted after bundling so those entry dependencies remain visible to backend
read-set capture. Membership, member contents and dependency identities
determine the hash. Each member receives a typed reuse policy with
`initializationModule` pointing to that path; query/mutation reuse and the
configured action and HTTP permissions remain unchanged.

A supporting backend uses this root for database and ordinary-action cache
identity and cold initialization. It loads all members before the first handler
runs and validates the complete initialization read set on reuse, including
entries not previously called. It never adds a member on a warm hit. Invocation
still uses the requested function and fresh request state. Database and
ordinary-action contexts remain separate cache kinds; HTTP actions keep
per-entry keys. The shared chunks would already be initialized by each member
independently; grouping avoids retaining duplicate copies of that graph merely
because the forwarding entry differs.

## Compatibility and safety

The setting is absent by default, preserving upstream explicit opt-in behavior.
`httpActions` separately defaults to false, and ordinary actions require an
explicit `actions.entries` list. Grouped entries always emit a typed policy;
other entries still emit the upstream boolean marker unless ordinary-action or
HTTP reuse is enabled. Older backends with typed-policy support ignore
`initializationModule` and keep per-entry reuse. Ordinary upstream backends do
not interpret a typed object as an opt-in and run those entries fresh. Backend
grouping support for each UDF kind must precede the new CLI output to obtain
shared contexts. When the setting is enabled, entry source files must not also
export `experimental_reuseContext`; one authority owns the emitted marker so
source and bundle policy cannot silently disagree.

The patch adds policy exports and, for grouped entries, an executable
initializer to the deployed graph. Reuse remains opportunistic and all backend
eligibility, UDF-type, cancellation, read-set validation, cache, and
memory-pressure rules continue to apply. An exclusion leaves the policy export
absent and removes the entry from any generated group, so the entry executes
fresh on both patched and ordinary backends.

## Rollback

For one entry, add a reviewed exclusion and redeploy the application. To disable
only HTTP-action reuse, set `httpActions` to false and redeploy the application.
To disable ordinary-action reuse, remove `actions` and redeploy; to retain reuse
with per-entry initialization, set `actions.grouping` to false and redeploy. For
a global rollback, remove `bundler.experimentalContextReuse` and every explicit
source marker, perform one complete root-application deployment, and restart
backend workers to clear saved contexts before traffic resumes.

Current upstream has no backend-wide database-UDF context-reuse switch. An exact
previous-image and configuration rollback restores that image's runtime
contract, but does not prove a global disable unless the previous image,
configuration, and complete application analysis establish that state.
