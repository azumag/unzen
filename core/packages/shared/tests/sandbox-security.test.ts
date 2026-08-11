import { describe, expect, it } from 'vitest';
import {
  SANDBOX_DISABLED_GLOBALS,
  SANDBOX_SECURITY_INIT,
} from '../src/sandbox-security';

describe('sandbox security contract', () => {
  it('keeps the published disabled globals aligned with QuickJS initialization', () => {
    const initializedGlobals = Array.from(
      SANDBOX_SECURITY_INIT.matchAll(
        /Object\.defineProperty\(globalThis,\s*'([^']+)'/g,
      ),
      (match) => match[1],
    );

    expect(initializedGlobals).toEqual([...SANDBOX_DISABLED_GLOBALS]);
  });
});
