# Initializer Asset Layout

The `init-project` skill separates source ownership from generated project paths:

```text
../../packages/
  core/          complete upstream core package plus local identity/runtime adaptation
  cli/
    src/templates/  the single upstream template source
../../overlays/
  manifest.json    pinned source/overlay hashes and capability ownership
  README.md        package-to-overlay mapping and synchronization boundary
  packages/cli/src/templates/
    overrides/     replacements for matching upstream template paths
    additions/     Moluoxixi-only files projected beside upstream templates
assets/
  runtime/       project-local executable and bundled dependencies
scripts/
  core/          transactional installation and ownership engine
  hosts/         host catalog and output contracts
  migrations/    Moluoxixi-version migration engine
  templates.mjs  fail-closed package-template and overlay reader
```

## Ownership Rules

- `../../packages/cli/src/templates` is the only upstream template tree. The initializer reads it directly; it must never copy those templates beneath the `init-project` skill source.
- `../../overlays/packages/cli/src/templates/overrides` mirrors the package subtree it replaces. `../../overlays/packages/cli/src/templates/additions` contains files with no upstream counterpart. Every payload file is declared in `manifest.json` with capability ownership and SHA-256 integrity data.
- Overlays remain outside `../../packages/cli`: `third_party.upstream.sync_paths` treats that package as an upstream merge boundary, while `../../overlays` is rebased separately as role-local behavior.
- Mechanical brand, path, command-name, and package-identity transforms live in code. They are not duplicated as overlay files.
- `scripts/templates.mjs` validates the upstream input hash, overlay hash, declaration completeness, and safe relative paths before any plan is built. Input drift fails closed.
- `../../packages` owns the complete upstream v0.6.15 package baseline, including source, tests, templates, migrations, package build files, and release helpers. Moluoxixi package changes are limited to collision-resistant identities, role-local entrypoints, and the channel/memory runtime contract.
- `role.yaml` lists the complete package trees, overlays, and bundled runtime in `third_party.upstream.paths`; `third_party.upstream.sync_paths` lists only identical upstream-to-role package paths that the synchronization script can merge automatically.
- Both packages use collision-resistant scoped names and retain the upstream package boundary. They are publishable for consumers that need the SDK or standalone CLI. Role-only CLI entrypoints stay outside the npm tarball because they require the complete installed role; role installation and project initialization continue to use that local role and never require registry access.
- Package release versions advance together and may move independently of the synchronized upstream baseline when Moluoxixi publication metadata or adaptations change. Both manifests must identify `https://github.com/moluoxixi/AIRules` so npm provenance matches the publishing workflow repository.
- `pnpm test` retains the complete upstream package regression suite. `pnpm run test:publish` is the cross-platform publication gate for the Moluoxixi core SDK and adapted channel/memory/upgrade CLI surfaces; `pnpm run verify:publish` additionally runs build, package linting, type-resolution checks, exact workspace dependency rewriting, and tarball installation. `pnpm run publish:dry-run` then exercises both package lifecycle hooks and npm publication dry runs.
- `assets/runtime` owns the project-local Moluoxixi executable and bundled runtime dependencies. Installation embeds the thin initializer below `.moluoxixi/runtime/update/init-project`, the upstream template subtree below `.moluoxixi/runtime/update/packages/cli/src/templates`, and overlays below `.moluoxixi/runtime/update/overlays`. No network access, npm install, TypeScript compilation, or full package runtime is required in the initialized project.
- `references` documents the initializer. Upstream parity belongs in `upstream-capability-map.md`; synchronization-preservation rules belong in `sync-preservation-contracts.json`; current output paths belong in `platforms.md`.

Host output paths and capability contexts are declared in `scripts/hosts/catalog.mjs`; projection code mirrors the upstream configurator maps rather than recursively copying host directories.

## Upstream Synchronization

Use `pnpm sync:moluoxixi:upstream --check --tag <tag>` to preview a three-way merge from the recorded Trellis baseline, or replace `--check` with `--apply` after reviewing the plan. The command merges `third_party.upstream.sync_paths`, applies collision-resistant package identity transforms, then rebases every declared overlay from the old localized upstream input onto the new localized input. Unprotected package conflicts and all overlay conflicts block apply.

After applying a newer tag, review the package and overlay diff. Update `role.yaml`, `sync-preservation-contracts.json`, the capability map, and the reconciliation ledger only after that review; the script updates overlay hashes but deliberately does not mark a new baseline as reviewed.
