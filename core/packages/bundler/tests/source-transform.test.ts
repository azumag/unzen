import { describe, expect, it } from 'vitest';
import {
  transformUnzenDefinitions,
  UnzenTransformError,
} from '../src/source-transform';

function executeRegistration(source: string): unknown[][] {
  const registrations: unknown[][] = [];
  class TestUnzenServer {
    defineRaw(...args: unknown[]): void {
      registrations.push(args);
    }
  }
  const executable = source.replace(/^import[^\n]+\n/m, '');
  new Function('UnzenServer', 'Server', 'unzen', executable)(
    TestUnzenServer,
    TestUnzenServer,
    { UnzenServer: TestUnzenServer },
  );
  return registrations;
}

describe('transformUnzenDefinitions', () => {
  it('extracts a typed inline function and preserves registration options', () => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer({ baseUrl: '/unzen' });
server.define('sum', (a: number, b: number): number => a + b, { timeout: 500 });`;

    const result = transformUnzenDefinitions(source, '/src/functions.ts');

    expect(result).not.toBeNull();
    expect(result?.definitions).toEqual([{
      name: 'sum',
      fileName: '/src/functions.ts',
      line: 3,
      column: 1,
      typeParameters: [],
      parameters: [
        { name: 'a', type: 'number', optional: false, rest: false },
        { name: 'b', type: 'number', optional: false, rest: false },
      ],
      returnType: 'number',
    }]);
    expect(result?.code).toContain('server.defineRaw(');
    expect(result?.code).not.toContain('a: number');
    const registrations = executeRegistration(result!.code);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.[0]).toBe('sum');
    expect(registrations[0]?.[2]).toEqual({ timeout: 500 });
    const fn = new Function(`return (${registrations[0]?.[1] as string})`)();
    expect(fn(2, 3)).toBe(5);
  });

  it('supports aliased and namespace imports and transforms multiple definitions', () => {
    const aliased = `import { UnzenServer as Server } from '@unzen/server';
const app = new Server();
app.define('double', (value: number) => value * 2);
app.define(\`triple\`, function (value: number) { return value * 3; });`;
    const namespace = `import * as unzen from '@unzen/server';
const app = new unzen.UnzenServer();
app.define('increment', (value: number) => value + 1);`;

    const aliasedResult = transformUnzenDefinitions(aliased, '/src/aliased.ts');
    const namespaceResult = transformUnzenDefinitions(namespace, '/src/namespace.ts');

    expect(aliasedResult?.definitions.map((definition) => definition.name))
      .toEqual(['double', 'triple']);
    expect(executeRegistration(aliasedResult!.code).map((entry) => entry[0]))
      .toEqual(['double', 'triple']);
    expect(namespaceResult?.definitions.map((definition) => definition.name))
      .toEqual(['increment']);
  });

  it('keeps TypeScript emit helpers with the extracted function', () => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('privateField', () => {
  class Counter {
    #value = 1;
    read() { return this.#value; }
  }
  return new Counter().read();
});`;

    const result = transformUnzenDefinitions(source, '/src/private-field.ts');
    const registration = executeRegistration(result!.code)[0]!;
    const fn = new Function(`return (${registration[1] as string})`)();

    expect(fn()).toBe(1);
  });

  it('captures generic, optional, default, rest, and inferred-unknown signature parts', () => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('format', <T extends string>(
  value: T,
  count?: number,
  uppercase = false,
  ...suffixes: string[]
): { value: T; count: number } => ({ value, count: count ?? 0 }));
server.define('untyped', value => value);`;

    const result = transformUnzenDefinitions(source, '/src/signatures.ts');

    expect(result?.definitions).toEqual([
      {
        name: 'format',
        fileName: '/src/signatures.ts',
        line: 3,
        column: 1,
        typeParameters: ['T extends string'],
        parameters: [
          { name: 'value', type: 'T', optional: false, rest: false },
          { name: 'count', type: 'number', optional: true, rest: false },
          { name: 'uppercase', type: 'unknown', optional: true, rest: false },
          { name: 'suffixes', type: 'string[]', optional: false, rest: true },
        ],
        returnType: '{ value: T; count: number }',
      },
      {
        name: 'untyped',
        fileName: '/src/signatures.ts',
        line: 9,
        column: 1,
        typeParameters: [],
        parameters: [
          { name: 'value', type: 'unknown', optional: false, rest: false },
        ],
        returnType: 'unknown',
      },
    ]);
  });

  it('keeps a default parameter required when a required parameter follows it', () => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('prefix', (prefix: string = 'id', value: number): string => prefix + value);`;

    const result = transformUnzenDefinitions(source, '/src/default-before-required.ts');

    expect(result?.definitions[0]?.parameters).toEqual([
      { name: 'prefix', type: 'string | undefined', optional: false, rest: false },
      { name: 'value', type: 'number', optional: false, rest: false },
    ]);
  });

  it('does not rewrite unrelated define methods or files without Unzen definitions', () => {
    const source = `const schema = { define(name, value) { return [name, value]; } };
schema.define('sum', (a, b) => a + b);`;

    expect(transformUnzenDefinitions(source, '/src/schema.ts')).toBeNull();
  });

  it.each([
    {
      label: 'dynamic name',
      statement: `const name = 'sum'; server.define(name, (a: number) => a);`,
      message: 'static string literal',
    },
    {
      label: 'referenced function',
      statement: `const sum = (a: number) => a; server.define('sum', sum);`,
      message: 'inline arrow or function expression',
    },
    {
      label: 'async function',
      statement: `server.define('sum', async (a: number) => a);`,
      message: 'synchronous',
    },
  ])('fails the build for an unsupported $label registration', ({ statement, message }) => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
${statement}`;

    expect(() => transformUnzenDefinitions(source, '/src/invalid.ts'))
      .toThrowError(UnzenTransformError);
    expect(() => transformUnzenDefinitions(source, '/src/invalid.ts'))
      .toThrow(message);
  });

  it('reports source coordinates for invalid registrations', () => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('bad', async () => 1);`;

    try {
      transformUnzenDefinitions(source, '/src/invalid.ts');
      throw new Error('expected transform to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(UnzenTransformError);
      expect((error as UnzenTransformError).fileName).toBe('/src/invalid.ts');
      expect((error as UnzenTransformError).line).toBe(3);
      expect((error as UnzenTransformError).column).toBe(1);
    }
  });

  it('leaves nested registrations untouched instead of guessing about lexical bindings', () => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
function register(server: { define(name: string, fn: Function): void }) {
  server.define('nested', (value: number) => value);
}`;

    expect(transformUnzenDefinitions(source, '/src/nested.ts')).toBeNull();
  });
});
