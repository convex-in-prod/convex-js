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
      "exclusions": {
        "generated/auth.ts": "The generated authentication graph remains under separate review."
      }
    }
  }
}
```

When `httpActions` is absent or false, the isolate bundler adds the ordinary
upstream `experimental_reuseContext = true` export to every root-application
isolate entry output except the listed paths. When `httpActions` is true, it
instead emits one typed policy that enables queries, mutations, and HTTP actions
while leaving ordinary actions disabled. Paths are relative to the configured
functions directory. Imported Convex components retain their own source policy.
The backend receives no application module allowlist. Node entry modules, schema
bundles, and auth configuration bundles are unchanged.

The reason strings keep exceptional modules and their operator rationale
together. Application tooling should verify that exclusions still name
database-UDF entries; the CLI additionally rejects an exclusion that does not
match a root isolate entry. Applications should review the full runtime import
graph before enabling the default. The CLI setting is not a substitute for that
source and emitted-bundle review.

## Compatibility and safety

The setting is absent by default, preserving upstream explicit opt-in behavior.
`httpActions` separately defaults to false, so existing users continue to emit
the upstream boolean marker. Enabling it requires a backend that accepts typed
context-reuse policy; an ordinary upstream backend does not interpret the typed
object as an opt-in. When the setting is enabled, entry source files must not
also export `experimental_reuseContext`; one authority owns the emitted marker
so source and bundle policy cannot silently disagree.

The patch changes only module analysis input. Reuse remains opportunistic and
all backend eligibility, UDF-type, cancellation, read-set validation, cache, and
memory-pressure rules continue to apply. An exclusion simply leaves the upstream
export absent, so the entry executes fresh on both patched and ordinary
backends.

## Rollback

For one entry, add a reviewed exclusion and redeploy the application. To disable
only HTTP-action reuse, set `httpActions` to false and redeploy the application.
For a global rollback, remove `bundler.experimentalContextReuse` and every
explicit source marker, perform one complete root-application deployment, and
restart backend workers to clear saved contexts before traffic resumes.

Current upstream has no backend-wide database-UDF context-reuse switch. An exact
previous-image and configuration rollback restores that image's runtime
contract, but does not prove a global disable unless the previous image,
configuration, and complete application analysis establish that state.
