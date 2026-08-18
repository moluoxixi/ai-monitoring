# Initializer Asset Layout

The `init-project` skill separates finalized package sources from generated
project state:

```text
../../packages/
  core/             finalized publishable core package
  cli/
    src/templates/  complete finalized template source
assets/
  runtime/          project-local executable and bundled dependencies
scripts/
  core/             transactional installation and ownership engine
  hosts/            host catalog and output contracts
  migrations/       Moluoxixi-version migration engine
  templates.mjs     finalized package-template reader
```

## Ownership Rules

- `../../packages/cli/src/templates` is the only distributed template tree. It already contains every reviewed Moluoxixi replacement and addition. The initializer reads it directly; it must never copy those templates beneath the `init-project` skill source.
- Repository-local upstream inputs, rebuild worktree, history, and scan reports live under `../../.sync`. The role-level `.gitignore` keeps that maintenance workspace out of Git and role distribution; see [upstream-maintenance.md](upstream-maintenance.md) for its immutable-source and export rules.
- `scripts/templates.mjs` accepts only safe relative paths and reads finalized templates directly from the package tree.
- Both packages use collision-resistant scoped names and retain the upstream package boundary. They are publishable for SDK or standalone CLI consumers. Role-only CLI entrypoints stay outside the npm tarball because they require the complete installed role.
- Package release versions advance together and may move independently of the upstream package version. Both manifests identify `https://github.com/moluoxixi/AIRules` so npm provenance matches the publishing workflow repository.
- `pnpm test` retains the package regression suite. `pnpm run verify:publish` runs publication-focused tests, build, package linting, type-resolution checks, exact workspace dependency rewriting, and tarball installation.
- `assets/runtime` owns the project-local Moluoxixi executable and bundled runtime dependencies. Installation embeds the thin initializer below `.moluoxixi/runtime/update/init-project` and the finalized template subtree below `.moluoxixi/runtime/update/packages/cli/src/templates`.
- `references` documents the distributed initializer and the maintenance boundary. Ignored upstream maintenance material stays under the role-local `../../.sync` directory and is never required at runtime.

Host output paths and capability contexts are declared in `scripts/hosts/catalog.mjs`;
projection code mirrors the package configurator maps instead of recursively
copying host directories.
