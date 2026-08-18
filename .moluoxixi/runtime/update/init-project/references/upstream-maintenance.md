# Upstream Maintenance Boundary

This role is maintained from an exact external baseline commit. The finalized
package trees under `roles/moluoxixi/packages/` are the only distributable
sources. The local `.sync` workspace is ignored and never required by the
initializer or by an installed role.

## Fixed Workspace

```text
roles/moluoxixi/.sync/
  source mirror  pristine checkout at the reviewed commit; read-only
  rebuild/       linked worktree from that commit; local adaptations only
  history/       reconciliation records and reviewed commit history
  reports/       scan, export, and verification reports
  manifest.json  pinned upstream commit and package mappings
```

The source mirror must remain clean and must never receive local edits or commits.
All Moluoxixi adaptations, package renames, template changes, and tests that
belong to the upstream replay happen in `rebuild/`. Do not edit the finalized
`roles/moluoxixi/packages/core` or `roles/moluoxixi/packages/cli` trees during
the replay.

There is deliberately no `.sync/work/` layer. The two worktrees and the
maintenance records are direct siblings so a path always identifies its role:
the source mirror is upstream input, `rebuild` is the adapted source, and `history` /
`reports` are audit output. Do not place reports, manifests, or reconciliation
notes inside either worktree.

## Export Contract

1. Fast-forward AIRules and fetch the exact upstream commit.
2. Create `rebuild/` from that commit and apply only the documented
   preservation contracts there, using local commits for review.
3. Run the rebuild tests and publication gates.
4. Export only `rebuild/packages/core` and `rebuild/packages/cli` to the two
   manifest-declared finalized paths.
5. Verify file contents, executable modes, package versions, and the export
   tree/content hashes. Record the source commit and verification result under
   `.sync/reports/` or `.sync/history/`.

The export is a deliberate reviewed operation. No script may merge upstream
changes, replay adaptations, or silently write finalized package trees.

## Deletions and History

There is no runtime overlay layer. Historical overlay material is disposable
local input and must not be recreated as `roles/moluoxixi/overlays` or copied
into an installed project. If an upstream file disappears or moves, remove a
finalized file only in `rebuild/`, and only after checking the preservation
contracts and recording the decision. Never preserve an old override merely
because it existed in an earlier release.

Reports stay beside the worktrees rather than inside `rebuild/`; putting them
inside the linked worktree makes it dirty and risks exporting maintenance data
as package source. The same rule applies to the source mirror: it is an immutable
upstream input, not a place for local notes or patches.
