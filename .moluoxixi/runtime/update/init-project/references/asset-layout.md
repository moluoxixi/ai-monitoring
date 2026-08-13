# Initializer Asset Layout

The `init-project` skill separates source ownership from generated project paths:

```text
assets/
  core/          reusable cross-host projection sources
  hosts/<host>/  host-owned native overlays
  project/       payload installed into every initialized project
  runtime/       project-local CLI executable, source, and dependencies
scripts/
  core/          transactional installation and ownership engine
  hosts/         host catalog and output contracts
  migrations/    Moluoxixi-version migration engine
```

## Ownership Rules

- `assets/core` owns skills, command bodies, and hook implementations reused by multiple hosts. Core sources may inspect host context at runtime; `core` means one canonical cross-host source, not host-agnostic behavior.
- `assets/hosts/<host>` owns native agents, settings, plugins, extensions, and host-specific wrappers. A host overlay may read `assets/core`, but it must not read another host's directory.
- `assets/project` owns the workflow, specs, Python scripts, managed root instructions, and other files installed for every selected host set.
- `assets/runtime` owns the project-local Moluoxixi executable, its shipped source tree, and bundled runtime dependencies. The updater and migration scripts are source-owned under `scripts/` and embedded below `.moluoxixi/runtime/update/init-project` during installation.
- `references` documents the initializer. Upstream parity belongs in `upstream-capability-map.md`; current output paths belong in `platforms.md`.

Hosts without an `assets/hosts/<host>` directory currently need only core skills and workflows. Their output paths are still declared in `scripts/hosts/catalog.mjs`.
