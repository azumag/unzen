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
    expect(result?.watchFiles).toEqual([]);
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

  it('rejects closure references at the referenced identifier location', () => {
    const source = `import { UnzenServer } from '@unzen/server';
const limit = 10;
const server = new UnzenServer();
server.define('bounded', (value: number) => value <= limit);`;
    const referenceColumn = source.split('\n')[3]!.lastIndexOf('limit') + 1;

    try {
      transformUnzenDefinitions(source, '/src/closure.ts');
      throw new Error('expected transform to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(UnzenTransformError);
      expect((error as Error).message).toContain('closure reference "limit"');
      expect((error as UnzenTransformError).fileName).toBe('/src/closure.ts');
      expect((error as UnzenTransformError).line).toBe(4);
      expect((error as UnzenTransformError).column).toBe(referenceColumn);
    }
  });

  it('rejects imported runtime values but ignores imported types', () => {
    const importedValue = `import { UnzenServer } from '@unzen/server';
import { normalize } from './normalize';
const server = new UnzenServer();
server.define('normalize', (value: string) => normalize(value));`;
    const importedType = `import { UnzenServer } from '@unzen/server';
import type { Payload } from './types';
const server = new UnzenServer();
server.define('read', (value: Payload): string => value.name);`;

    expect(() => transformUnzenDefinitions(importedValue, '/src/imported-value.ts'))
      .toThrow('closure reference "normalize"');
    expect(transformUnzenDefinitions(importedType, '/src/imported-type.ts')).not.toBeNull();
  });

  it.each([
    ['fetch', `fetch('/private')`, 'forbidden global "fetch"'],
    ['global object access', `globalThis.fetch('/private')`, 'forbidden global "globalThis"'],
    ['eval', `eval('1 + 1')`, 'forbidden global "eval"'],
    ['CommonJS require', `require('node:fs')`, 'forbidden global "require"'],
    ['dynamic import', `import('./private.js')`, 'dynamic import'],
  ])('rejects %s in an extracted function', (_label, expression, message) => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('unsafe', () => ${expression});`;

    expect(() => transformUnzenDefinitions(source, '/src/unsafe.ts')).toThrow(message);
  });

  it.each([
    ['Math.random', 'Math.random()'],
    ['Date.now', 'Date.now()'],
    ['the current Date', 'new Date()'],
  ])('rejects nondeterministic %s access', (_label, expression) => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('unstable', () => ${expression});`;

    expect(() => transformUnzenDefinitions(source, '/src/nondeterministic.ts'))
      .toThrow('nondeterministic API');
  });

  it.each([
    ['Math.random', 'const { random } = Math; return random();'],
    ['Date.now', 'const { now: currentTime } = Date; return currentTime();'],
  ])('rejects destructured nondeterministic %s access', (_label, body) => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('unstableAlias', () => { ${body} });`;

    expect(() => transformUnzenDefinitions(source, '/src/nondeterministic-alias.ts'))
      .toThrow('nondeterministic API');
  });

  it('rejects a root function this binding while allowing local class methods', () => {
    const contextual = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('contextual', function () { return this.value; });`;

    expect(() => transformUnzenDefinitions(contextual, '/src/contextual.ts'))
      .toThrow('function context "this"');

    const localClass = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('localClass', () => {
  class Counter {
    value = 1;
    read() { return this.value; }
  }
  return new Counter().read();
});`;
    expect(transformUnzenDefinitions(localClass, '/src/local-class.ts')).not.toBeNull();
  });

  it('rejects import.meta because the extracted function has no module context', () => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('contextual', () => import.meta.url);`;

    expect(() => transformUnzenDefinitions(source, '/src/contextual-meta.ts'))
      .toThrow('module context "import.meta"');
  });

  it('allows this owned by a local class static block', () => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('staticClass', () => {
  class Counter {
    static value = 0;
    static { this.value = 2; }
  }
  return Counter.value;
});`;

    expect(transformUnzenDefinitions(source, '/src/static-class.ts')).not.toBeNull();
  });

  it('uses lexical scope instead of matching restricted API names as text', () => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('safeNames', function (value: number) {
  // fetch('/comment-only')
  const note = "globalThis.fetch('/string-only')";
  const fetch = (input: number) => input + 1;
  const apply = (input: number) => fetch(input);
  return { note, value: Math.max(apply(value), arguments.length) };
});`;

    const result = transformUnzenDefinitions(source, '/src/safe-names.ts');

    expect(result).not.toBeNull();
  });

  it('allows recursion through a named inline function expression', () => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('factorial', function factorial(value: number): number {
  return value <= 1 ? 1 : value * factorial(value - 1);
});`;

    const result = transformUnzenDefinitions(source, '/src/recursive.ts');
    const registration = executeRegistration(result!.code)[0]!;
    const factorial = new Function(`return (${registration[1] as string})`)();

    expect(factorial(5)).toBe(120);
  });

  it('does not let an unrelated block binding hide a closure reference', () => {
    const source = `import { UnzenServer } from '@unzen/server';
const external = () => 42;
const server = new UnzenServer();
server.define('scoped', () => {
  if (false) {
    const external = () => 0;
    return external();
  }
  return external();
});`;

    expect(() => transformUnzenDefinitions(source, '/src/scoped.ts'))
      .toThrow('closure reference "external"');
  });

  it('resolves shorthand property reads to their lexical value binding', () => {
    const source = `import { UnzenServer } from '@unzen/server';
const external = 42;
const server = new UnzenServer();
server.define('shorthand', () => ({ external }));`;

    expect(() => transformUnzenDefinitions(source, '/src/shorthand.ts'))
      .toThrow('closure reference "external"');
  });

  it('checks runtime class heritage while ignoring erased implements types', () => {
    const capturedBase = `import { UnzenServer } from '@unzen/server';
class Base {}
const server = new UnzenServer();
server.define('classHeritage', () => {
  class Derived extends Base {}
  return new Derived();
});`;
    const erasedInterface = `import { UnzenServer } from '@unzen/server';
import type { Shape } from './shape';
const server = new UnzenServer();
server.define('classType', () => {
  class Box implements Shape { value = 1; }
  return new Box().value;
});`;

    expect(() => transformUnzenDefinitions(capturedBase, '/src/class-heritage.ts'))
      .toThrow('closure reference "Base"');
    expect(transformUnzenDefinitions(erasedInterface, '/src/class-type.ts')).not.toBeNull();
  });

  it('rejects arguments captured by a root arrow but allows regular function arguments', () => {
    const arrow = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('arrowArguments', () => arguments.length);`;
    const regular = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('functionArguments', function () { return arguments.length; });`;

    expect(() => transformUnzenDefinitions(arrow, '/src/arrow-arguments.ts'))
      .toThrow('closure reference "arguments"');
    expect(transformUnzenDefinitions(regular, '/src/function-arguments.ts')).not.toBeNull();
  });

  it.each([
    [
      'parameter reassignment',
      '(input: number) => { input += 1; return input; }',
      'assignment to input parameter "input"',
    ],
    [
      'parameter property assignment',
      '(input: { value: number }) => { input.value = 1; return input.value; }',
      'assignment to input parameter "input"',
    ],
    [
      'parameter property update',
      '(input: { value: number }) => { input.value++; return input.value; }',
      'assignment to input parameter "input"',
    ],
    [
      'parameter property deletion',
      '(input: { value?: number }) => { delete input.value; return input; }',
      'assignment to input parameter "input"',
    ],
    [
      'parameter for-of target',
      '(input: number[], values: number[]) => { for (input[0] of values) {} return input; }',
      'assignment to input parameter "input"',
    ],
    [
      'parameter destructuring target',
      '(input: { value: number }, next: { value: number }) => { ' +
        '({ value: input.value } = next); return input; }',
      'assignment to input parameter "input"',
    ],
    [
      'arguments assignment',
      'function (input: number) { arguments[0] = 1; return input; }',
      'assignment to input binding "arguments"',
    ],
    [
      'standard global assignment',
      '() => { Math.max = () => 1; return Math.max(2, 3); }',
      'assignment to standard global "Math"',
    ],
  ])('rejects %s', (_label, fn, message) => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('mutation', ${fn});`;

    expect(() => transformUnzenDefinitions(source, '/src/mutation.ts')).toThrow(message);
  });

  it('allows assignments to function-local working state', () => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('localMutation', (input: number) => {
  let total = 0;
  total += input;
  const result = { value: 0 };
  result.value = total;
  return result;
});`;

    expect(transformUnzenDefinitions(source, '/src/local-mutation.ts')).not.toBeNull();
  });

  it('allows deterministic standard-library operations', () => {
    const source = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('deterministic', (timestamp: number, json: string) => {
  const date = new Date(timestamp);
  const values = JSON.parse(json);
  return Math.max(date.getUTCFullYear(), Number(values.year), Date.UTC(2000, 0, 1));
});`;

    expect(transformUnzenDefinitions(source, '/src/deterministic.ts')).not.toBeNull();
  });
});
