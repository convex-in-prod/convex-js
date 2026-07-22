# Published Convex Packages

This directory owns the immutable `convex-in-prod` package archives. Each
`packages/convex/<source-sha>/` directory contains:

- `convex.tgz`, the package built from that exact convex-js source commit; and
- `manifest.json`, the package version, source and upstream provenance, SHA-512
  checksum, lockfile integrity value, and build-run URL.

The source SHA identifies the code used to build the package. The later Git
commit that adds the archive to this directory is the publication commit. Do not
overwrite an existing source-SHA directory or rebuild an archive under an
existing path.

The `convex-in-prod.github.io` Pages build mirrors this directory from an exact
convex-js publication commit. Existing consumers can therefore keep using:

```text
https://convex-in-prod.github.io/packages/convex/<source-sha>/convex.tgz
```

To publish a new archive:

1. Run the manually dispatched `Build convex-in-prod package` workflow for the
   exact reviewed source commit.
2. Download its artifact and verify the embedded `convexInProd` provenance,
   package version, SHA-512 checksum, and integrity value.
3. Add a new source-SHA directory and manifest in a separate `packages: publish`
   commit. Keep the maintained source patch train below publication data
   commits.
4. Update the Pages repository workflow to mirror packages from that exact
   publication commit, then verify the existing public URL byte-for-byte.

The Pages repository is a delivery mirror, not the package source of truth.
