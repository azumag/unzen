/**
 * Tests for practical server-side sample functions
 *
 * These functions demonstrate the core value proposition of QJS-proto:
 * "Safely delegate server-side computation to the browser sandbox"
 *
 * Each function is tested via the Hono app's POST /unzen/exec/:name endpoint,
 * which exercises the full QuickJS sandbox execution path.
 *
 * TDD approach: These tests are written BEFORE the implementation (Red phase).
 */

import { describe, it, expect } from 'vitest';
import { app } from '../server';

/**
 * Helper: Execute a registered function via the server's exec endpoint.
 * Returns both HTTP status and parsed JSON response body.
 */
async function execFunction(name: string, ...args: unknown[]) {
  const res = await app.request(`/unzen/exec/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

// ============================================================
// formValidate: Server-side form validation delegated to sandbox
// Why server-side: Tamper-proof validation (no browser devtools bypass)
// Why delegable: QuickJS sandbox has frozen prototypes, no eval
// ============================================================
describe('formValidate', () => {
  describe('email validation', () => {
    it('user@example.com -> valid', async () => {
      const { status, body } = await execFunction('formValidate', {
        email: 'user@example.com',
      });
      expect(status).toBe(200);
      expect(body.result).toEqual({ valid: true, errors: {} });
    });

    it('userexample.com (no @) -> Invalid email format', async () => {
      const { status, body } = await execFunction('formValidate', {
        email: 'userexample.com',
      });
      expect(status).toBe(200);
      expect(body.result).toEqual({
        valid: false,
        errors: { email: 'Invalid email format' },
      });
    });

    it('user@ (no domain) -> Invalid email format', async () => {
      const { status, body } = await execFunction('formValidate', {
        email: 'user@',
      });
      expect(status).toBe(200);
      expect(body.result).toEqual({
        valid: false,
        errors: { email: 'Invalid email format' },
      });
    });

    it('user@mail.example.com (subdomain) -> valid', async () => {
      const { status, body } = await execFunction('formValidate', {
        email: 'user@mail.example.com',
      });
      expect(status).toBe(200);
      expect(body.result).toEqual({ valid: true, errors: {} });
    });
  });

  describe('credit card validation (Luhn algorithm)', () => {
    it('4111111111111111 (valid Visa test number) -> valid', async () => {
      const { status, body } = await execFunction('formValidate', {
        creditCard: '4111111111111111',
      });
      expect(status).toBe(200);
      expect(body.result).toEqual({ valid: true, errors: {} });
    });

    it('1234567890123456 (fails Luhn checksum) -> Card number failed Luhn check', async () => {
      const { status, body } = await execFunction('formValidate', {
        creditCard: '1234567890123456',
      });
      expect(status).toBe(200);
      expect(body.result).toEqual({
        valid: false,
        errors: { creditCard: 'Card number failed Luhn check' },
      });
    });

    it('"4111 1111 1111 1111" (spaces stripped before Luhn) -> valid', async () => {
      const { status, body } = await execFunction('formValidate', {
        creditCard: '4111 1111 1111 1111',
      });
      expect(status).toBe(200);
      expect(body.result).toEqual({ valid: true, errors: {} });
    });

    it('411111 (too short, < 13 digits) -> Invalid card number format', async () => {
      const { status, body } = await execFunction('formValidate', {
        creditCard: '411111',
      });
      expect(status).toBe(200);
      expect(body.result).toEqual({
        valid: false,
        errors: { creditCard: 'Invalid card number format' },
      });
    });

    it('0000000000000000 (all zeros, Luhn sum=0) -> Card number failed Luhn check', async () => {
      const { status, body } = await execFunction('formValidate', {
        creditCard: '0000000000000000',
      });
      expect(status).toBe(200);
      expect(body.result).toEqual({
        valid: false,
        errors: { creditCard: 'Card number failed Luhn check' },
      });
    });
  });

  describe('phone validation', () => {
    it('+1-555-123-4567 (US format) -> valid', async () => {
      const { status, body } = await execFunction('formValidate', {
        phone: '+1-555-123-4567',
      });
      expect(status).toBe(200);
      expect(body.result).toEqual({ valid: true, errors: {} });
    });

    it('+81-90-1234-5678 (JP format) -> valid', async () => {
      const { status, body } = await execFunction('formValidate', {
        phone: '+81-90-1234-5678',
      });
      expect(status).toBe(200);
      expect(body.result).toEqual({ valid: true, errors: {} });
    });

    it('"not-a-phone" (alphabetic) -> Invalid phone number format', async () => {
      const { status, body } = await execFunction('formValidate', {
        phone: 'not-a-phone',
      });
      expect(status).toBe(200);
      expect(body.result).toEqual({
        valid: false,
        errors: { phone: 'Invalid phone number format' },
      });
    });
  });

  describe('password strength', () => {
    it('MyP@ssw0rd!23 (12+ chars, mixed) -> valid', async () => {
      const { status, body } = await execFunction('formValidate', {
        password: 'MyP@ssw0rd!23',
      });
      expect(status).toBe(200);
      expect(body.result).toEqual({ valid: true, errors: {} });
    });

    it('Ab1! (4 chars, < 8 minimum) -> Password must be at least 8 characters', async () => {
      const { status, body } = await execFunction('formValidate', {
        password: 'Ab1!',
      });
      expect(status).toBe(200);
      expect(body.result).toEqual({
        valid: false,
        errors: { password: 'Password must be at least 8 characters' },
      });
    });
  });

  describe('multiple field validation', () => {
    it('all invalid fields -> errors for all 4 fields', async () => {
      const { status, body } = await execFunction('formValidate', {
        email: 'bad-email',
        creditCard: '0000000000000000',
        phone: 'abc',
        password: 'short',
      });
      expect(status).toBe(200);
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
      const errors = result.errors as Record<string, string>;
      expect(errors.email).toBe('Invalid email format');
      expect(errors.creditCard).toBe('Card number failed Luhn check');
      expect(errors.phone).toBe('Invalid phone number format');
      expect(errors.password).toBe('Password must be at least 8 characters');
    });

    it('all valid fields -> valid with empty errors', async () => {
      const { status, body } = await execFunction('formValidate', {
        email: 'test@example.com',
        creditCard: '4111111111111111',
        phone: '+1-555-000-0000',
        password: 'Str0ng!Pass#',
      });
      expect(status).toBe(200);
      expect(body.result).toEqual({ valid: true, errors: {} });
    });

    it('empty fields object -> valid (no fields to validate)', async () => {
      const { status, body } = await execFunction('formValidate', {});
      expect(status).toBe(200);
      expect(body.result).toEqual({ valid: true, errors: {} });
    });
  });
});

// ============================================================
// calculatePrice: Server-side price calculation delegated to sandbox
// Why server-side: Prevent price manipulation by malicious clients
// Why delegable: Pure computation, RTT 100ms->2ms latency gain
// ============================================================
describe('calculatePrice', () => {
  describe('basic subtotal calculation', () => {
    it('2x$10 Widget + 1x$25 Gadget -> subtotal $45', async () => {
      const { status, body } = await execFunction('calculatePrice', {
        items: [
          { name: 'Widget', price: 10, quantity: 2 },
          { name: 'Gadget', price: 25, quantity: 1 },
        ],
        region: 'US-CA',
      });
      expect(status).toBe(200);
      const result = body.result as Record<string, number>;
      expect(result.subtotal).toBe(45);
    });

    it('empty items array -> all fields zero', async () => {
      const { status, body } = await execFunction('calculatePrice', {
        items: [],
        region: 'US-CA',
      });
      expect(status).toBe(200);
      const result = body.result as Record<string, number>;
      expect(result.subtotal).toBe(0);
      expect(result.discount).toBe(0);
      expect(result.tax).toBe(0);
      expect(result.shipping).toBe(0);
      expect(result.total).toBe(0);
    });
  });

  describe('tax calculation', () => {
    it('$100 in US-CA -> tax $7.25 (7.25%)', async () => {
      const { status, body } = await execFunction('calculatePrice', {
        items: [{ name: 'Item', price: 100, quantity: 1 }],
        region: 'US-CA',
      });
      expect(status).toBe(200);
      const result = body.result as Record<string, number>;
      expect(result.tax).toBe(7.25);
    });

    it('$100 in JP -> tax $10 (10%)', async () => {
      const { body } = await execFunction('calculatePrice', {
        items: [{ name: 'Item', price: 100, quantity: 1 }],
        region: 'JP',
      });
      const result = body.result as Record<string, number>;
      expect(result.tax).toBe(10);
    });

    it('$100 in EU-DE -> tax $19 (19%)', async () => {
      const { body } = await execFunction('calculatePrice', {
        items: [{ name: 'Item', price: 100, quantity: 1 }],
        region: 'EU-DE',
      });
      const result = body.result as Record<string, number>;
      expect(result.tax).toBe(19);
    });

    it('$100 in unknown region -> tax $0 (0%)', async () => {
      const { body } = await execFunction('calculatePrice', {
        items: [{ name: 'Item', price: 100, quantity: 1 }],
        region: 'UNKNOWN',
      });
      const result = body.result as Record<string, number>;
      expect(result.tax).toBe(0);
    });
  });

  describe('discount calculation', () => {
    it('$100 with 10% percentage discount -> discount $10, tax on $90 = $9', async () => {
      const { body } = await execFunction('calculatePrice', {
        items: [{ name: 'Item', price: 100, quantity: 1 }],
        region: 'JP',
        discount: { type: 'percentage', value: 10 },
      });
      const result = body.result as Record<string, number>;
      expect(result.subtotal).toBe(100);
      expect(result.discount).toBe(10);
      // Tax computed on afterDiscount: (100-10) * 10% = 9
      expect(result.tax).toBe(9);
      // Total: 90 + 9 + 0 shipping = 99
      expect(result.total).toBe(99);
    });

    it('$100 with $15 fixed discount -> discount $15', async () => {
      const { body } = await execFunction('calculatePrice', {
        items: [{ name: 'Item', price: 100, quantity: 1 }],
        region: 'JP',
        discount: { type: 'fixed', value: 15 },
      });
      const result = body.result as Record<string, number>;
      expect(result.discount).toBe(15);
    });

    it('$150 tiered ($100+ = 5%) -> discount $7.5', async () => {
      const { body } = await execFunction('calculatePrice', {
        items: [{ name: 'Item', price: 50, quantity: 3 }],
        region: 'JP',
        discount: { type: 'tiered' },
      });
      const result = body.result as Record<string, number>;
      expect(result.discount).toBe(7.5);
    });

    it('$300 tiered ($200+ = 10%) -> discount $30', async () => {
      const { body } = await execFunction('calculatePrice', {
        items: [{ name: 'Item', price: 100, quantity: 3 }],
        region: 'JP',
        discount: { type: 'tiered' },
      });
      const result = body.result as Record<string, number>;
      expect(result.discount).toBe(30);
    });

    it('$600 tiered ($500+ = 15%) -> discount $90', async () => {
      const { body } = await execFunction('calculatePrice', {
        items: [{ name: 'Item', price: 200, quantity: 3 }],
        region: 'JP',
        discount: { type: 'tiered' },
      });
      const result = body.result as Record<string, number>;
      expect(result.discount).toBe(90);
    });

    it('$50 with $200 fixed discount -> discount capped at $50 (subtotal)', async () => {
      const { body } = await execFunction('calculatePrice', {
        items: [{ name: 'Item', price: 50, quantity: 1, weight: 1 }],
        region: 'JP',
        discount: { type: 'fixed', value: 200 },
      });
      const result = body.result as Record<string, number>;
      // Fixed discount capped at subtotal
      expect(result.discount).toBe(50);
    });
  });

  describe('shipping calculation', () => {
    it('$50 order with 2kg -> shipping $9 ($5 base + $2/kg * 2)', async () => {
      const { body } = await execFunction('calculatePrice', {
        items: [{ name: 'Item', price: 50, quantity: 1, weight: 2 }],
        region: 'US-CA',
      });
      const result = body.result as Record<string, number>;
      expect(result.shipping).toBe(9);
    });

    it('$120 order -> free shipping ($100+ threshold)', async () => {
      const { body } = await execFunction('calculatePrice', {
        items: [{ name: 'Item', price: 120, quantity: 1, weight: 2 }],
        region: 'US-CA',
      });
      const result = body.result as Record<string, number>;
      expect(result.shipping).toBe(0);
    });
  });

  describe('total calculation', () => {
    it('$100 JP with 10% off -> total $99 (90 + 9 tax + 0 shipping)', async () => {
      const { body } = await execFunction('calculatePrice', {
        items: [{ name: 'A', price: 50, quantity: 2, weight: 1 }],
        region: 'JP',
        discount: { type: 'percentage', value: 10 },
      });
      const result = body.result as Record<string, number>;
      expect(result.subtotal).toBe(100);
      expect(result.discount).toBe(10);
      expect(result.tax).toBe(9);
      expect(result.shipping).toBe(0);
      expect(result.total).toBe(99);
    });
  });
});

// ============================================================
// markdownToHtml: Server-side markdown rendering delegated to sandbox
// Why server-side: SSR content rendering is traditionally server CPU work
// Why delegable: Offload CPU to client, reduce server cost
// ============================================================
describe('markdownToHtml', () => {
  describe('headings', () => {
    it('# Hello -> <h1>Hello</h1>', async () => {
      const { status, body } = await execFunction('markdownToHtml', '# Hello');
      expect(status).toBe(200);
      expect(body.result).toBe('<h1>Hello</h1>');
    });

    it('## World -> <h2>World</h2>', async () => {
      const { body } = await execFunction('markdownToHtml', '## World');
      expect(body.result).toBe('<h2>World</h2>');
    });

    it('###### Deep -> <h6>Deep</h6>', async () => {
      const { body } = await execFunction('markdownToHtml', '###### Deep');
      expect(body.result).toBe('<h6>Deep</h6>');
    });
  });

  describe('inline formatting', () => {
    it('**bold** -> <strong>bold</strong>', async () => {
      const { body } = await execFunction('markdownToHtml', 'This is **bold** text');
      expect(body.result).toContain('<strong>bold</strong>');
    });

    it('*italic* -> <em>italic</em>', async () => {
      const { body } = await execFunction('markdownToHtml', 'This is *italic* text');
      expect(body.result).toContain('<em>italic</em>');
    });

    it('`code` -> <code>code</code>', async () => {
      const { body } = await execFunction('markdownToHtml', 'Use `console.log`');
      expect(body.result).toContain('<code>console.log</code>');
    });

    it('[text](url) -> <a href="url">text</a>', async () => {
      const { body } = await execFunction('markdownToHtml', 'Visit [Example](https://example.com)');
      expect(body.result).toContain('<a href="https://example.com">Example</a>');
    });

    it('![alt](url) -> <img src="url" alt="alt" />', async () => {
      const { body } = await execFunction('markdownToHtml', '![Logo](logo.png)');
      expect(body.result).toContain('<img src="logo.png" alt="Logo"');
    });
  });

  describe('code blocks', () => {
    it('fenced code block with <script> -> HTML-escaped content', async () => {
      const input = '```\n<script>alert("xss")</script>\n```';
      const { body } = await execFunction('markdownToHtml', input);
      const result = body.result as string;
      expect(result).toContain('<pre><code>');
      expect(result).toContain('&lt;script&gt;');
      expect(result).not.toContain('<script>');
    });

    it('unclosed code block -> graceful degradation (content rendered)', async () => {
      const input = '```\nsome code\nmore code';
      const { body } = await execFunction('markdownToHtml', input);
      const result = body.result as string;
      // Unclosed code block should still render content, not silently drop it
      expect(result).toContain('some code');
      expect(result).toContain('<pre><code>');
    });
  });

  describe('lists', () => {
    it('- items -> <ul><li>...</li></ul>', async () => {
      const input = '- Apple\n- Banana\n- Cherry';
      const { body } = await execFunction('markdownToHtml', input);
      const result = body.result as string;
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>Apple</li>');
      expect(result).toContain('<li>Banana</li>');
      expect(result).toContain('<li>Cherry</li>');
      expect(result).toContain('</ul>');
    });

    it('1. items -> <ol><li>...</li></ol>', async () => {
      const input = '1. First\n2. Second\n3. Third';
      const { body } = await execFunction('markdownToHtml', input);
      const result = body.result as string;
      expect(result).toContain('<ol>');
      expect(result).toContain('<li>First</li>');
      expect(result).toContain('<li>Second</li>');
      expect(result).toContain('</ol>');
    });
  });

  describe('paragraphs', () => {
    it('plain text -> <p>text</p>', async () => {
      const { body } = await execFunction('markdownToHtml', 'Hello world');
      expect(body.result).toBe('<p>Hello world</p>');
    });

    it('two paragraphs separated by blank line', async () => {
      const input = 'First paragraph\n\nSecond paragraph';
      const { body } = await execFunction('markdownToHtml', input);
      const result = body.result as string;
      expect(result).toContain('<p>First paragraph</p>');
      expect(result).toContain('<p>Second paragraph</p>');
    });

    it('empty string -> empty output', async () => {
      const { body } = await execFunction('markdownToHtml', '');
      expect(body.result).toBe('');
    });
  });

  describe('XSS prevention', () => {
    it('<script> in inline text -> escaped to &lt;script&gt;', async () => {
      const { body } = await execFunction('markdownToHtml', '<script>alert(1)</script>');
      const result = body.result as string;
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('javascript: in link URL -> link stripped, text preserved', async () => {
      const { body } = await execFunction('markdownToHtml', '[click](javascript:alert(1))');
      const result = body.result as string;
      expect(result).not.toContain('javascript:');
      expect(result).toContain('click');
    });

    it('javascript: in image URL -> image removed', async () => {
      const { body } = await execFunction('markdownToHtml', '![img](javascript:alert(1))');
      const result = body.result as string;
      expect(result).not.toContain('javascript:');
    });

    it('data: in link URL -> link stripped', async () => {
      const { body } = await execFunction('markdownToHtml', '[click](data:text/html,<script>alert(1)</script>)');
      const result = body.result as string;
      expect(result).not.toContain('data:');
    });
  });
});

// ============================================================
// textStats: Server-side text analysis delegated to sandbox
// Why server-side: Readability scoring traditionally computed on server
// Why delegable: Pure computation, ideal for sandbox execution
// ============================================================
describe('textStats', () => {
  describe('basic counts', () => {
    it('"Hello world" -> 11 chars', async () => {
      const { status, body } = await execFunction('textStats', 'Hello world');
      expect(status).toBe(200);
      const result = body.result as Record<string, unknown>;
      expect(result.chars).toBe(11);
    });

    it('"The quick brown fox" -> 4 words', async () => {
      const { body } = await execFunction('textStats', 'The quick brown fox');
      const result = body.result as Record<string, unknown>;
      expect(result.words).toBe(4);
    });

    it('"Hello. How are you? I am fine!" -> 3 sentences', async () => {
      const { body } = await execFunction('textStats', 'Hello. How are you? I am fine!');
      const result = body.result as Record<string, unknown>;
      expect(result.sentences).toBe(3);
    });

    it('3 paragraphs separated by blank lines -> paragraphs=3', async () => {
      const { body } = await execFunction('textStats', 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.');
      const result = body.result as Record<string, unknown>;
      expect(result.paragraphs).toBe(3);
    });

    it('empty string -> all counts zero', async () => {
      const { body } = await execFunction('textStats', '');
      const result = body.result as Record<string, unknown>;
      expect(result.chars).toBe(0);
      expect(result.words).toBe(0);
      expect(result.sentences).toBe(0);
      expect(result.paragraphs).toBe(0);
    });

    it('"Hello world" (no period) -> sentences=1 (default)', async () => {
      const { body } = await execFunction('textStats', 'Hello world');
      const result = body.result as Record<string, unknown>;
      // No sentence-ending punctuation, falls back to 1
      expect(result.sentences).toBe(1);
    });
  });

  describe('averages', () => {
    it('"The cat sat" (all 3-letter words) -> avgWordLength=3.0', async () => {
      const { body } = await execFunction('textStats', 'The cat sat');
      const result = body.result as Record<string, number>;
      expect(result.avgWordLength).toBe(3);
    });
  });

  describe('syllable counting', () => {
    it('"Beautiful day" -> 4 syllables (beau-ti-ful=3 + day=1)', async () => {
      const { body } = await execFunction('textStats', 'Beautiful day');
      const result = body.result as Record<string, number>;
      // Heuristic: 'beautiful' = beau-ti-ful (3 vowel groups), 'day' = 1
      expect(result.syllables).toBe(4);
    });
  });

  describe('reading time', () => {
    it('200 words -> readingTimeMinutes=1.0 (200 wpm)', async () => {
      const words200 = Array(200).fill('word').join(' ');
      const { body } = await execFunction('textStats', words200);
      const result = body.result as Record<string, number>;
      expect(result.readingTimeMinutes).toBe(1);
    });

    it('empty text -> readingTimeMinutes=0', async () => {
      const { body } = await execFunction('textStats', '');
      const result = body.result as Record<string, number>;
      expect(result.readingTimeMinutes).toBe(0);
    });
  });

  describe('Flesch-Kincaid grade', () => {
    it('simple sentences -> low grade (< 5, clamped >= 0)', async () => {
      // "The cat sat on the mat. The dog ran to the park. It was a fun day."
      // 15 words / 3 sentences = 5 words/sentence
      // ~15 syllables / 15 words = 1.0 syllables/word
      // FK = 0.39*5 + 11.8*1.0 - 15.59 = 1.95 + 11.8 - 15.59 = -1.84 → clamped to 0
      const text = 'The cat sat on the mat. The dog ran to the park. It was a fun day.';
      const { body } = await execFunction('textStats', text);
      const result = body.result as Record<string, number>;
      expect(result.fleschKincaidGrade).toBe(0);
    });

    it('complex academic text -> high grade (> 10)', async () => {
      const text = 'The epistemological foundations of contemporary philosophical discourse necessitate a comprehensive examination of phenomenological methodologies.';
      const { body } = await execFunction('textStats', text);
      const result = body.result as Record<string, number>;
      expect(result.fleschKincaidGrade).toBeGreaterThan(10);
    });

    it('empty text -> grade 0', async () => {
      const { body } = await execFunction('textStats', '');
      const result = body.result as Record<string, number>;
      expect(result.fleschKincaidGrade).toBe(0);
    });
  });
});
