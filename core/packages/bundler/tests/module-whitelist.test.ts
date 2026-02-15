/**
 * Tests for module whitelist security
 *
 * The whitelist controls which npm modules can be bundled into sandbox functions.
 * Node.js built-in modules are always blocked for security.
 */

import { describe, it, expect } from 'vitest';
import { checkModuleAllowed, isNodeBuiltin, DEFAULT_ALLOWED_MODULES } from '../src/module-whitelist';

describe('module-whitelist', () => {
  describe('isNodeBuiltin', () => {
    it('should identify fs as Node.js built-in', () => {
      expect(isNodeBuiltin('fs')).toBe(true);
    });

    it('should identify child_process as Node.js built-in', () => {
      expect(isNodeBuiltin('child_process')).toBe(true);
    });

    it('should identify path as Node.js built-in', () => {
      expect(isNodeBuiltin('path')).toBe(true);
    });

    it('should identify http as Node.js built-in', () => {
      expect(isNodeBuiltin('http')).toBe(true);
    });

    it('should identify net as Node.js built-in', () => {
      expect(isNodeBuiltin('net')).toBe(true);
    });

    it('should identify crypto as Node.js built-in', () => {
      expect(isNodeBuiltin('crypto')).toBe(true);
    });

    it('should identify node:fs as Node.js built-in', () => {
      expect(isNodeBuiltin('node:fs')).toBe(true);
    });

    it('should NOT identify lodash as Node.js built-in', () => {
      expect(isNodeBuiltin('lodash')).toBe(false);
    });

    it('should NOT identify date-fns as Node.js built-in', () => {
      expect(isNodeBuiltin('date-fns')).toBe(false);
    });
  });

  describe('checkModuleAllowed', () => {
    it('should allow module matching exact pattern', () => {
      expect(checkModuleAllowed('lodash', ['lodash'])).toBe(true);
    });

    it('should allow subpath with wildcard pattern', () => {
      expect(checkModuleAllowed('lodash/sortBy', ['lodash/*'])).toBe(true);
    });

    it('should reject module not in allowed list', () => {
      expect(checkModuleAllowed('axios', ['lodash'])).toBe(false);
    });

    it('should always reject Node.js built-in modules', () => {
      // Even if explicitly allowed, Node built-ins are blocked
      expect(checkModuleAllowed('fs', ['fs'])).toBe(false);
    });

    it('should always reject node: prefixed modules', () => {
      expect(checkModuleAllowed('node:fs', ['node:fs'])).toBe(false);
    });

    it('should allow date-fns with exact match', () => {
      expect(checkModuleAllowed('date-fns', ['date-fns'])).toBe(true);
    });

    it('should allow date-fns subpath with wildcard', () => {
      expect(checkModuleAllowed('date-fns/format', ['date-fns/*'])).toBe(true);
    });

    it('should reject child_process regardless of allowed list', () => {
      expect(checkModuleAllowed('child_process', ['child_process', '*'])).toBe(false);
    });

    // Review fix: Path traversal attack prevention
    it('should reject path traversal via .. in module name', () => {
      // Attack: 'lodash/../../fs-extra' starts with 'lodash/' but escapes the package
      expect(checkModuleAllowed('lodash/../../fs-extra', ['lodash/*'])).toBe(false);
    });

    it('should reject path traversal with single ..', () => {
      expect(checkModuleAllowed('lodash/../evil', ['lodash/*'])).toBe(false);
    });
  });

  describe('DEFAULT_ALLOWED_MODULES', () => {
    it('should include common safe modules', () => {
      expect(DEFAULT_ALLOWED_MODULES).toContain('lodash');
      expect(DEFAULT_ALLOWED_MODULES).toContain('lodash/*');
      expect(DEFAULT_ALLOWED_MODULES).toContain('date-fns');
      expect(DEFAULT_ALLOWED_MODULES).toContain('date-fns/*');
      expect(DEFAULT_ALLOWED_MODULES).toContain('validator');
    });

    it('should NOT include Node.js built-ins', () => {
      expect(DEFAULT_ALLOWED_MODULES).not.toContain('fs');
      expect(DEFAULT_ALLOWED_MODULES).not.toContain('child_process');
      expect(DEFAULT_ALLOWED_MODULES).not.toContain('http');
    });
  });
});
