import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { safePathWithPathApi } from '../browser-harness/webgpu-2b-split/server-safe-path.mjs';

describe('endpoint diagnostic server path containment', () => {
  it('accepts nested files with POSIX separators', () => {
    expect(safePathWithPathApi(posix, '/repo/root', 'nested/file.js')).toBe('/repo/root/nested/file.js');
  });

  it('accepts nested files with Windows separators', () => {
    expect(safePathWithPathApi(win32, 'C:\\repo\\root', 'nested/file.js')).toBe(
      'C:\\repo\\root\\nested\\file.js',
    );
  });

  it('keeps parent traversal rooted under the static root', () => {
    expect(safePathWithPathApi(posix, '/repo/root', '../outside.js')).toBe('/repo/root/outside.js');
    expect(safePathWithPathApi(win32, 'C:\\repo\\root', '..\\outside.js')).toBe(
      'C:\\repo\\root\\outside.js',
    );
  });

  it('rejects a Windows drive-qualified component that path.relative treats as absolute', () => {
    expect(() => safePathWithPathApi(win32, 'C:\\repo\\root', 'C:\\outside.js')).toThrow(
      'path escapes root',
    );
  });
});
