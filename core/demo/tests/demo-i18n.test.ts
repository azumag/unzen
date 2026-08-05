/**
 * Unit tests for the demo copy/i18n structure (public/demo-i18n.js).
 *
 * Verifies issue #104 requirements:
 * - copy lives in a per-language structure (not hard-coded inline English),
 * - en and ja dictionaries cover the SAME key set (a language switch can never
 *   silently fall back to "[missing key]"),
 * - t() interpolates {params} and falls back gracefully.
 */

import { describe, it, expect } from 'vitest';
import { LANGUAGES, messages, flattenKeys, makeI18n } from '../public/demo-i18n.js';

describe('messages structure', () => {
  it('defines en and ja dictionaries', () => {
    expect(LANGUAGES).toEqual(['en', 'ja']);
    expect(messages.en).toBeDefined();
    expect(messages.ja).toBeDefined();
  });

  it('en and ja expose exactly the same key set', () => {
    const enKeys = Object.keys(flattenKeys(messages.en)).sort();
    const jaKeys = Object.keys(flattenKeys(messages.ja)).sort();
    expect(jaKeys).toEqual(enKeys);
  });

  it('has no empty values (a language switch never leaves blank copy)', () => {
    for (const lang of LANGUAGES) {
      for (const [key, value] of Object.entries(flattenKeys(messages[lang]))) {
        expect(String(value).trim().length, `${lang}.${key} must not be empty`).toBeGreaterThan(0);
      }
    }
  });
});

describe('makeI18n', () => {
  it('looks up nested keys with dot paths', () => {
    const { t } = makeI18n('en');
    expect(t('states.running-in-browser')).toBe('Running in browser sandbox…');
    expect(t('demos.spam.title')).toBe('1. Spam Detection');
  });

  it('interpolates {params}', () => {
    const { t } = makeI18n('en');
    expect(t('stats.sampleCount', { count: 3 })).toBe('n=3');
    expect(t('errors.requiredNumber', { value: 'abc' })).toBe('Enter a valid number (got "abc").');
  });

  it('leaves unknown placeholders untouched and falls back for unknown keys', () => {
    const { t } = makeI18n('en');
    expect(t('errors.requiredNumber', {})).toContain('{value}');
    expect(t('does.not.exist')).toBe('[does.not.exist]');
  });

  it('falls back to English for unknown languages', () => {
    expect(makeI18n('fr').lang).toBe('en');
    expect(makeI18n('fr').t('common.title')).toBe(messages.en.common.title);
  });

  it('detects ja copy for the ja language', () => {
    const { t } = makeI18n('ja');
    expect(t('states.cancelled')).toBe('キャンセル済み');
  });

  it('covers every UI state in both languages', () => {
    for (const lang of LANGUAGES) {
      const { t } = makeI18n(lang);
      for (const state of [
        'idle',
        'validating',
        'preparing',
        'running-in-browser',
        'falling-back-to-server',
        'running-on-server',
        'succeeded',
        'failed',
        'cancelling',
        'cancelled',
      ]) {
        expect(t(`states.${state}`), `${lang} states.${state}`).not.toMatch(/^\[/);
      }
    }
  });
});
