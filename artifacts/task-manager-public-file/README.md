# Local TaskSpace package candidates

These archives were packed with `bun pm pack --ignore-scripts` from the three public packages in `depa-flows.ts`. They are unpublished candidates; versions and archive hashes are in `manifest.json`. The Windows directory-fsync compatibility of installed file-support 0.1.5 is retained.

The public source implementation is committed as `1db14a4` in `depa-flows.ts`. The three archives and their extracted workspace snapshots were checked byte for byte against those public sources (25 packaged files). New owner/preparation tests are retained in that source repository.

`vendor/task-manager/*` contains the exact package files extracted from these archives. Root workspace overrides select these packages for every consumer, including older transitive declarations. Runtime code never imports a neighboring checkout. This avoids Bun 1.3.14 failing to resolve relative tarball overrides; absolute tarball overrides succeeded but were discarded because they are not portable.

Restore dependencies from the repository root with `bun install --ignore-scripts --frozen-lockfile`. Verify package contents against the archives before accepting new candidates. The archives are provenance, not a registry publication receipt.
