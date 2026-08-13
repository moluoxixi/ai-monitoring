import { describe, expect, it } from 'vitest';
import { ExtensionsService } from '../src/extensions/extensions.service';

describe('ExtensionsService', () => {
  it('exposes only installed extensions and resolves their aliases', () => {
    const service = new ExtensionsService();

    expect(service.definitions().map((extension) => extension.key)).toEqual(['codex', 'claude', 'qoder']);
    expect(service.resolve('Codex_Desktop')).toBe('codex');
    expect(service.resolve('claude-code')).toBe('claude');
    expect(service.resolve('gemini')).toBe('other');
  });

  it('returns defensive copies of extension metadata', () => {
    const service = new ExtensionsService();
    const extension = service.get('codex');

    extension.aliases.length = 0;
    extension.adapter.capabilities.completed = false;

    expect(service.get('codex').aliases.length).toBeGreaterThan(0);
    expect(service.get('codex').adapter.capabilities.completed).toBe(true);
  });
});
