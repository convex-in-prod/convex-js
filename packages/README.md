# Immutable package distribution

Published Convex archives and manifests are owned by
[`convex-in-prod.github.io`](https://github.com/convex-in-prod/convex-in-prod.github.io/tree/main/public/packages/convex).
Their public URLs remain unchanged:

```text
https://convex-in-prod.github.io/packages/convex/<source-sha>/convex.tgz
```

Each source-SHA directory is immutable. The manifest records the source and
upstream commits, package version, SHA-512 checksum, lockfile integrity and
build provenance. Historical archives retain their original bytes and metadata.

The build workflow remains in this source repository. Publish a verified
workflow artifact directly into the distribution repository; do not add archive
publication commits to the source patch train. See
[the release procedure](../patches/README.md#rebase-and-release).
