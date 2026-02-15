/**
 * Tests for heavy computation sample functions
 *
 * These functions demonstrate the high-value use case of unzen core:
 * offloading CPU-intensive server-side computations to the browser sandbox.
 *
 * Each function is tested via the Hono app's POST /unzen/exec/:name endpoint,
 * which exercises the full QuickJS sandbox execution path.
 *
 * TDD approach: Tests written BEFORE implementation (Red phase).
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
// jsonSchemaValidate: JSON Schema validation (Draft-07 subset)
//
// Why heavy: Real-world schemas can have 100+ fields with nested objects.
// Sandbox timeout: 500ms (medium tier)
// ============================================================
describe('jsonSchemaValidate', () => {
  describe('type validation', () => {
    it('string type with valid string -> valid', async () => {
      const schema = { type: 'string' };
      const { status, body } = await execFunction('jsonSchemaValidate', schema, 'hello');
      expect(status).toBe(200);
      expect(body.result).toEqual({ valid: true, errors: [] });
    });

    it('string type with number -> invalid', async () => {
      const schema = { type: 'string' };
      const { body } = await execFunction('jsonSchemaValidate', schema, 42);
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
      expect((result.errors as string[]).length).toBeGreaterThan(0);
    });

    it('number type with number -> valid', async () => {
      const schema = { type: 'number' };
      const { body } = await execFunction('jsonSchemaValidate', schema, 3.14);
      expect(body.result).toEqual({ valid: true, errors: [] });
    });

    it('integer type with 42 -> valid', async () => {
      const schema = { type: 'integer' };
      const { body } = await execFunction('jsonSchemaValidate', schema, 42);
      expect(body.result).toEqual({ valid: true, errors: [] });
    });

    it('integer type with 3.14 -> invalid', async () => {
      const schema = { type: 'integer' };
      const { body } = await execFunction('jsonSchemaValidate', schema, 3.14);
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
    });

    it('boolean type with true -> valid', async () => {
      const schema = { type: 'boolean' };
      const { body } = await execFunction('jsonSchemaValidate', schema, true);
      expect(body.result).toEqual({ valid: true, errors: [] });
    });

    it('array type with [] -> valid', async () => {
      const schema = { type: 'array' };
      const { body } = await execFunction('jsonSchemaValidate', schema, [1, 2, 3]);
      expect(body.result).toEqual({ valid: true, errors: [] });
    });

    it('object type with {} -> valid', async () => {
      const schema = { type: 'object' };
      const { body } = await execFunction('jsonSchemaValidate', schema, { key: 'val' });
      expect(body.result).toEqual({ valid: true, errors: [] });
    });

    it('null type with null -> valid', async () => {
      const schema = { type: 'null' };
      const { body } = await execFunction('jsonSchemaValidate', schema, null);
      expect(body.result).toEqual({ valid: true, errors: [] });
    });
  });

  describe('string constraints', () => {
    it('minLength 3 with "ab" -> invalid', async () => {
      const schema = { type: 'string', minLength: 3 };
      const { body } = await execFunction('jsonSchemaValidate', schema, 'ab');
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
    });

    it('maxLength 5 with "toolong" -> invalid', async () => {
      const schema = { type: 'string', maxLength: 5 };
      const { body } = await execFunction('jsonSchemaValidate', schema, 'toolong');
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
    });

    it('pattern /^\\d+$/ with "123" -> valid', async () => {
      const schema = { type: 'string', pattern: '^\\d+$' };
      const { body } = await execFunction('jsonSchemaValidate', schema, '123');
      expect(body.result).toEqual({ valid: true, errors: [] });
    });

    it('pattern /^\\d+$/ with "abc" -> invalid', async () => {
      const schema = { type: 'string', pattern: '^\\d+$' };
      const { body } = await execFunction('jsonSchemaValidate', schema, 'abc');
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
    });

    it('enum with valid value -> valid', async () => {
      const schema = { type: 'string', enum: ['red', 'green', 'blue'] };
      const { body } = await execFunction('jsonSchemaValidate', schema, 'red');
      expect(body.result).toEqual({ valid: true, errors: [] });
    });

    it('enum with invalid value -> invalid', async () => {
      const schema = { type: 'string', enum: ['red', 'green', 'blue'] };
      const { body } = await execFunction('jsonSchemaValidate', schema, 'yellow');
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
    });
  });

  describe('number constraints', () => {
    it('minimum 10 with 5 -> invalid', async () => {
      const schema = { type: 'number', minimum: 10 };
      const { body } = await execFunction('jsonSchemaValidate', schema, 5);
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
    });

    it('maximum 100 with 150 -> invalid', async () => {
      const schema = { type: 'number', maximum: 100 };
      const { body } = await execFunction('jsonSchemaValidate', schema, 150);
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
    });

    it('minimum 0, maximum 100 with 50 -> valid', async () => {
      const schema = { type: 'number', minimum: 0, maximum: 100 };
      const { body } = await execFunction('jsonSchemaValidate', schema, 50);
      expect(body.result).toEqual({ valid: true, errors: [] });
    });
  });

  describe('object validation', () => {
    it('required fields present -> valid', async () => {
      const schema = {
        type: 'object',
        required: ['name', 'age'],
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      };
      const { body } = await execFunction('jsonSchemaValidate', schema, { name: 'Alice', age: 30 });
      expect(body.result).toEqual({ valid: true, errors: [] });
    });

    it('missing required field -> invalid', async () => {
      const schema = {
        type: 'object',
        required: ['name', 'age'],
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      };
      const { body } = await execFunction('jsonSchemaValidate', schema, { name: 'Alice' });
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
      expect((result.errors as string[]).some(e => e.includes('age'))).toBe(true);
    });

    it('property type mismatch -> invalid', async () => {
      const schema = {
        type: 'object',
        properties: {
          age: { type: 'number' },
        },
      };
      const { body } = await execFunction('jsonSchemaValidate', schema, { age: 'not-a-number' });
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
    });

    it('additionalProperties false rejects extra fields', async () => {
      const schema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      };
      const { body } = await execFunction('jsonSchemaValidate', schema, { name: 'Alice', extra: 'field' });
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
    });
  });

  describe('array validation', () => {
    it('items type validation -> valid', async () => {
      const schema = { type: 'array', items: { type: 'number' } };
      const { body } = await execFunction('jsonSchemaValidate', schema, [1, 2, 3]);
      expect(body.result).toEqual({ valid: true, errors: [] });
    });

    it('items type mismatch -> invalid', async () => {
      const schema = { type: 'array', items: { type: 'number' } };
      const { body } = await execFunction('jsonSchemaValidate', schema, [1, 'two', 3]);
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
    });

    it('minItems 2 with [1] -> invalid', async () => {
      const schema = { type: 'array', minItems: 2 };
      const { body } = await execFunction('jsonSchemaValidate', schema, [1]);
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
    });

    it('maxItems 3 with [1,2,3,4] -> invalid', async () => {
      const schema = { type: 'array', maxItems: 3 };
      const { body } = await execFunction('jsonSchemaValidate', schema, [1, 2, 3, 4]);
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
    });
  });

  describe('schema guard', () => {
    it('null schema -> invalid with error message', async () => {
      const { body } = await execFunction('jsonSchemaValidate', null, { name: 'Alice' });
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
      expect((result.errors as string[])[0]).toContain('schema must be a non-null object');
    });
  });

  describe('nested objects', () => {
    it('deeply nested schema validates correctly', async () => {
      const schema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string', minLength: 1 },
              address: {
                type: 'object',
                properties: {
                  city: { type: 'string' },
                  zip: { type: 'string', pattern: '^\\d{5}$' },
                },
              },
            },
          },
        },
      };
      const data = { user: { name: 'Alice', address: { city: 'Tokyo', zip: '12345' } } };
      const { body } = await execFunction('jsonSchemaValidate', schema, data);
      expect(body.result).toEqual({ valid: true, errors: [] });
    });

    it('nested validation error includes path', async () => {
      const schema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              age: { type: 'number' },
            },
          },
        },
      };
      const { body } = await execFunction('jsonSchemaValidate', schema, { user: { age: 'old' } });
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(false);
      // Error path should reference the nested location
      expect((result.errors as string[]).some(e => e.includes('user.age'))).toBe(true);
    });
  });
});

// ============================================================
// sortData: Multi-key array sort
//
// Why heavy: Dashboard tables with 5,000+ rows, multiple sort keys
// Sandbox timeout: 500ms (medium tier)
// ============================================================
describe('sortData', () => {
  describe('single key sort', () => {
    it('sort by name ascending', async () => {
      const data = [{ name: 'Charlie' }, { name: 'Alice' }, { name: 'Bob' }];
      const { status, body } = await execFunction('sortData', data, [{ key: 'name', order: 'asc' }]);
      expect(status).toBe(200);
      const result = body.result as Array<Record<string, unknown>>;
      expect(result.map(r => r.name)).toEqual(['Alice', 'Bob', 'Charlie']);
    });

    it('sort by name descending', async () => {
      const data = [{ name: 'Charlie' }, { name: 'Alice' }, { name: 'Bob' }];
      const { body } = await execFunction('sortData', data, [{ key: 'name', order: 'desc' }]);
      const result = body.result as Array<Record<string, unknown>>;
      expect(result.map(r => r.name)).toEqual(['Charlie', 'Bob', 'Alice']);
    });

    it('sort by numeric value ascending', async () => {
      const data = [{ score: 90 }, { score: 70 }, { score: 85 }];
      const { body } = await execFunction('sortData', data, [{ key: 'score', order: 'asc' }]);
      const result = body.result as Array<Record<string, number>>;
      expect(result.map(r => r.score)).toEqual([70, 85, 90]);
    });

    it('sort by numeric value descending', async () => {
      const data = [{ score: 90 }, { score: 70 }, { score: 85 }];
      const { body } = await execFunction('sortData', data, [{ key: 'score', order: 'desc' }]);
      const result = body.result as Array<Record<string, number>>;
      expect(result.map(r => r.score)).toEqual([90, 85, 70]);
    });
  });

  describe('multi-key sort', () => {
    it('sort by department asc, then salary desc', async () => {
      const data = [
        { name: 'Alice', dept: 'Engineering', salary: 120000 },
        { name: 'Bob', dept: 'Engineering', salary: 150000 },
        { name: 'Charlie', dept: 'Design', salary: 100000 },
        { name: 'Diana', dept: 'Design', salary: 110000 },
      ];
      const { body } = await execFunction('sortData', data, [
        { key: 'dept', order: 'asc' },
        { key: 'salary', order: 'desc' },
      ]);
      const result = body.result as Array<Record<string, unknown>>;
      expect(result.map(r => r.name)).toEqual(['Diana', 'Charlie', 'Bob', 'Alice']);
    });
  });

  describe('edge cases', () => {
    it('empty array -> empty array', async () => {
      const { body } = await execFunction('sortData', [], [{ key: 'name', order: 'asc' }]);
      expect(body.result).toEqual([]);
    });

    it('single element -> same array', async () => {
      const data = [{ name: 'Alice' }];
      const { body } = await execFunction('sortData', data, [{ key: 'name', order: 'asc' }]);
      const result = body.result as Array<Record<string, unknown>>;
      expect(result).toEqual([{ name: 'Alice' }]);
    });

    it('equal values maintain relative order (stability)', async () => {
      const data = [
        { name: 'Alice', group: 'A' },
        { name: 'Bob', group: 'A' },
        { name: 'Charlie', group: 'A' },
      ];
      const { body } = await execFunction('sortData', data, [{ key: 'group', order: 'asc' }]);
      const result = body.result as Array<Record<string, string>>;
      // All have same group, so order should be preserved (stable sort)
      expect(result.map(r => r.name)).toEqual(['Alice', 'Bob', 'Charlie']);
    });

    it('missing key values sort to end', async () => {
      const data = [
        { name: 'Alice', score: 90 },
        { name: 'Bob' },
        { name: 'Charlie', score: 70 },
      ];
      const { body } = await execFunction('sortData', data, [{ key: 'score', order: 'asc' }]);
      const result = body.result as Array<Record<string, unknown>>;
      // Items with undefined score should sort to end
      expect(result[0].name).toBe('Charlie');
      expect(result[1].name).toBe('Alice');
      expect(result[2].name).toBe('Bob');
    });

    it('no sort keys -> original order', async () => {
      const data = [{ a: 3 }, { a: 1 }, { a: 2 }];
      const { body } = await execFunction('sortData', data, []);
      const result = body.result as Array<Record<string, number>>;
      expect(result).toEqual([{ a: 3 }, { a: 1 }, { a: 2 }]);
    });
  });
});

// ============================================================
// levenshteinDistance: Text similarity calculation
//
// Why heavy: O(n*m) algorithm, clearly CPU-intensive for long strings
// Sandbox timeout: 500ms (medium tier)
// ============================================================
describe('levenshteinDistance', () => {
  describe('basic distance calculations', () => {
    it('"kitten" vs "sitting" -> distance 3', async () => {
      const { status, body } = await execFunction('levenshteinDistance', 'kitten', 'sitting');
      expect(status).toBe(200);
      const result = body.result as Record<string, number>;
      expect(result.distance).toBe(3);
    });

    it('identical strings -> distance 0', async () => {
      const { body } = await execFunction('levenshteinDistance', 'hello', 'hello');
      const result = body.result as Record<string, number>;
      expect(result.distance).toBe(0);
      expect(result.similarity).toBe(1);
    });

    it('completely different strings -> distance = length of longer', async () => {
      const { body } = await execFunction('levenshteinDistance', 'abc', 'xyz');
      const result = body.result as Record<string, number>;
      expect(result.distance).toBe(3);
    });

    it('"" vs "hello" -> distance 5 (all insertions)', async () => {
      const { body } = await execFunction('levenshteinDistance', '', 'hello');
      const result = body.result as Record<string, number>;
      expect(result.distance).toBe(5);
    });

    it('"hello" vs "" -> distance 5 (all deletions)', async () => {
      const { body } = await execFunction('levenshteinDistance', 'hello', '');
      const result = body.result as Record<string, number>;
      expect(result.distance).toBe(5);
    });

    it('"" vs "" -> distance 0', async () => {
      const { body } = await execFunction('levenshteinDistance', '', '');
      const result = body.result as Record<string, number>;
      expect(result.distance).toBe(0);
      expect(result.similarity).toBe(1);
    });
  });

  describe('similarity score', () => {
    it('"kitten" vs "sitting" -> similarity ~0.57', async () => {
      const { body } = await execFunction('levenshteinDistance', 'kitten', 'sitting');
      const result = body.result as Record<string, number>;
      // similarity = 1 - (3 / 7) ≈ 0.571...
      expect(result.similarity).toBeCloseTo(1 - 3 / 7, 2);
    });

    it('"abc" vs "abc" -> similarity 1.0', async () => {
      const { body } = await execFunction('levenshteinDistance', 'abc', 'abc');
      const result = body.result as Record<string, number>;
      expect(result.similarity).toBe(1);
    });

    it('"a" vs "b" -> similarity 0.0', async () => {
      const { body } = await execFunction('levenshteinDistance', 'a', 'b');
      const result = body.result as Record<string, number>;
      expect(result.similarity).toBe(0);
    });
  });

  describe('single character operations', () => {
    it('"cat" vs "car" -> distance 1 (substitution)', async () => {
      const { body } = await execFunction('levenshteinDistance', 'cat', 'car');
      const result = body.result as Record<string, number>;
      expect(result.distance).toBe(1);
    });

    it('"cat" vs "cats" -> distance 1 (insertion)', async () => {
      const { body } = await execFunction('levenshteinDistance', 'cat', 'cats');
      const result = body.result as Record<string, number>;
      expect(result.distance).toBe(1);
    });

    it('"cats" vs "cat" -> distance 1 (deletion)', async () => {
      const { body } = await execFunction('levenshteinDistance', 'cats', 'cat');
      const result = body.result as Record<string, number>;
      expect(result.distance).toBe(1);
    });
  });
});
