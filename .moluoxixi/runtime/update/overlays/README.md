# Moluoxixi Package Overlays

This directory contains role-local changes layered over synchronized upstream package sources.

```text
upstream source                         role-local overlay
../packages/cli/src/templates/<path> -> packages/cli/src/templates/overrides/<path>
new template target <path>           -> packages/cli/src/templates/additions/<path>
```

`manifest.json` records every payload file, its target path, capability ownership, and SHA-256 integrity data. Overrides and additions stay outside `../packages/cli` because that package is synchronized as an upstream merge boundary; the synchronization script rebases this overlay tree separately.
