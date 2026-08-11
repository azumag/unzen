import { describe, expect, it } from 'vitest';
import { normalizeUnzenEndpoint } from '../src/endpoint';

describe('normalizeUnzenEndpoint', () => {
  it.each([
    ['  https://example.com/unzen///  ', 'https://example.com/unzen'],
    ['HTTP://EXAMPLE.COM:80/a/../unzen/', 'http://example.com/unzen'],
    ['/api/unzen///', '/api/unzen'],
    ['/', ''],
  ])('normalizes %j', (input, expected) => {
    expect(normalizeUnzenEndpoint(input)).toBe(expected);
  });

  it.each([
    '',
    'relative/path',
    '//attacker.example/unzen',
    'javascript:alert(1)',
    'https://user:secret@example.com/unzen',
    'https://example.com/unzen?tenant=1',
    'https://example.com/unzen#fragment',
    `https://example.com/${'x'.repeat(2048)}`,
  ])('rejects unsafe endpoint %j', (input) => {
    expect(() => normalizeUnzenEndpoint(input)).toThrow('endpoint must');
  });
});
