import { describe, expect, it } from 'vitest';
import { ExtensionsService } from '../src/extensions/extensions.service';

describe('ExtensionsService', () => {
  it('exposes independent canonical CLI/Desktop extensions', () => {
    const service = new ExtensionsService();

    expect(service.definitions().map((extension) => extension.key)).toEqual([
      'codex-cli', 'codex-desktop', 'claude-cli', 'claude-desktop',
      'qoder-cli', 'qoder-desktop', 'qoder-quest', 'hermes-cli', 'hermes-desktop', 'cursor-cli', 'cursor-desktop',
    ]);
    expect(service.resolve('codex-desktop')).toBe('codex-desktop');
    expect(service.resolve('claude-code')).toBe('other');
    expect(service.resolve('qoder', 'desktop')).toBe('other');
    expect(service.resolve('qoder-desktop', 'desktop')).toBe('qoder-desktop');
    expect(service.resolve('qoder-quest', 'quest')).toBe('qoder-quest');
    expect(service.resolve('qoder-quest', 'desktop')).toBe('other');
    expect(service.resolve('cursor', 'cli')).toBe('other');
    expect(service.migrateLegacyKey('claude-code')).toBe('claude-cli');
    expect(service.migrateLegacyKey('qoder-desktop')).toBe('qoder-desktop');
    expect(service.resolve('gemini')).toBe('other');
  });

  it('returns defensive copies of extension metadata', () => {
    const service = new ExtensionsService();
    const extension = service.get('codex-cli');

    extension.adapter.capabilities.completed = false;

    expect(service.get('codex-cli').adapter.capabilities.completed).toBe(true);
  });

  it('reports only event capabilities implemented by each desktop adapter', () => {
    const service = new ExtensionsService();
    expect(service.get('qoder-quest').adapter.capabilities).toMatchObject({
      completed: true, failed: false, interrupted: false, toolFailed: false, tracing: false,
    });
    expect(service.get('qoder-desktop').adapter.capabilities).toMatchObject({
      completed: true, failed: false, interrupted: false, toolFailed: false, tracing: false,
    });
    expect(service.get('claude-desktop').adapter.capabilities).toMatchObject({
      completed: true, failed: true, interrupted: true, toolFailed: false, tracing: false,
    });
    expect(service.get('hermes-desktop').adapter.capabilities).toMatchObject({
      completed: true, failed: true, interrupted: true, toolFailed: true, tracing: false,
    });
    expect(service.get('codex-desktop').adapter.capabilities).toMatchObject({
      completed: true, failed: true, interrupted: true, toolFailed: false, tracing: false,
    });
  });
});
