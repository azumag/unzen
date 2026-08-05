import { describe, expect, it } from 'vitest';
import {
  createBrowserBuiltInModelDescriptor,
  validateBrowserBuiltInModelDescriptor,
} from '../src/browser-built-in-model.js';

describe('BrowserBuiltInModelDescriptor (Chrome full-model backend)', () => {
  it('describes the Chrome full-model backend without fabricated segment geometry', () => {
    const descriptor = createBrowserBuiltInModelDescriptor('150.0.0.0');

    expect(descriptor).toEqual({
      schemaVersion: '1.0.0',
      backend: 'browser-built-in-full-model',
      provider: 'chrome',
      api: 'prompt-api',
      runtimeVersion: '150.0.0.0',
      capabilities: ['full-model-in-document', 'streaming', 'abort', 'context-window'],
    });
    // The full-model backend must never fabricate segment / hash / VRAM geometry.
    expect('segments' in descriptor).toBe(false);
    expect('totalLayers' in descriptor).toBe(false);
    expect('modelWeightHash' in descriptor).toBe(false);
    expect('estimatedVramMB' in descriptor).toBe(false);
  });

  it('validates the descriptor and rejects fabricated segment geometry', () => {
    const valid = validateBrowserBuiltInModelDescriptor(
      createBrowserBuiltInModelDescriptor(),
    );
    expect(valid.status).toBe('valid');

    const result = validateBrowserBuiltInModelDescriptor({
      ...createBrowserBuiltInModelDescriptor(),
      totalLayers: 60,
      modelWeightHash: 'sha256:segment-0',
    });
    expect(result.status).toBe('invalid');
    expect(result.issues.map((issue) => issue.code)).toContain('segment-geometry-forbidden');
  });

  it('rejects an unsupported descriptor schema version', () => {
    const result = validateBrowserBuiltInModelDescriptor({
      ...createBrowserBuiltInModelDescriptor(),
      schemaVersion: '9.9.9',
    });
    expect(result.status).toBe('invalid');
  });
});
