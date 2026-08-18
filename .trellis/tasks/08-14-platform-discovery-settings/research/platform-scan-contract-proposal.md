## Scenario: Host platform discovery and display selection

### 1. Scope / Trigger
- Trigger: The extensions API and Vue settings page need to distinguish a reliable empty host scan from an environment where host inspection is unavailable.
- Scope: `PlatformScannerService`, `ExtensionsController`, and the extensions view.

### 2. Signatures
```ts
interface PlatformScanSnapshot {
  scanScope: 'host' | 'unsupported';
  scanStatus: 'reliable' | 'degraded' | 'unavailable';
  scannedAt: string | null;
  platforms: Record<string, ExtensionRuntimeState>;
}

GET /api/extensions -> {
  extensions: ExtensionCard[];
  configurableExtensions: string[];
  visibleExtensions: string[];
  scanScope: string;
  scanStatus: string;
  scannedAt: string | null;
}
```

### 3. Contracts
- `reliable` and `degraded` host scans derive `configurableExtensions` only from `platform.detected === true`.
- `unavailable` scans (Docker, non-Windows, or a host-level exception) use the complete supported extension directory as the configurable fallback.
- `visibleExtensions` is the persisted user preference intersected with the current configurable set. Without an explicit preference it equals the configurable set. An explicit empty preference remains empty.
- Installation detection may use a command, exact executable, exact process path, Windows AppX package, or exact uninstall product name. Monitor hook/configuration state must not make a platform appear installed.
- Shared process names must not classify a runtime: for example, `codex.exe` is not enough to classify Codex CLI because Desktop can spawn the same executable.

### 4. Validation & Error Matrix
| Condition | Scan status | Configurable set | API behavior |
|---|---|---|---|
| Windows probes complete | `reliable` | detected platforms, possibly empty | return 200 |
| One probe channel fails | `degraded` | platforms detected by remaining signals | return 200 |
| Docker/non-Windows | `unavailable` | all supported platforms | return 200 |
| Host scan throws | `unavailable` | all supported platforms | return 200 |
| Preference contains a platform outside configurable set | n/a | unchanged | return 400 |
| Explicit empty preference | n/a | unchanged | persist and return `[]` |

### 5. Good/Base/Bad Cases
- Good: A fresh reliable scan detects Codex CLI and Claude Desktop, so the settings checkboxes contain only those two keys.
- Base: A Docker scan returns all supported keys with `scanStatus: unavailable`; the UI does not apply a detected-only filter that would hide every card.
- Bad: A shared `.codex` directory, a hook file, or a generic `codex.exe` process is used as the sole installation signal for Codex CLI/Desktop.

### 6. Tests Required
- Scanner returns `unavailable` when the host-level probe throws.
- Controller returns detected-only configurable/visible sets for a reliable scan.
- Controller returns all supported keys only for `unavailable`.
- Controller preserves an explicit empty preference and rejects an undetected key.
- Frontend selection helpers filter by the server-provided configurable set and keep the unavailable fallback visible.

### 7. Wrong vs Correct
#### Wrong
```ts
const detected = supported.filter(key => snapshot.platforms[key]?.detected);
return detected.length ? detected : supported;
```

#### Correct
```ts
const configurable = snapshot.scanStatus === 'unavailable'
  ? supported
  : supported.filter(key => snapshot.platforms[key]?.detected === true);
```
