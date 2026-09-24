import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listenSplitHarness } from '../browser-harness/webgpu-2b-split/serve.mjs';
import {
  DEFAULT_ENDPOINT_WEBGPU_DIAGNOSTIC_PORT,
  resolveEndpointWebgpuDiagnosticPort,
} from '../browser-harness/webgpu-2b-split/server-port.mjs';

const servers = [
  {
    path: '../browser-harness/endpoint-tile-webgpu/serve.mjs',
    resolverCall: 'const PORT = resolveEndpointWebgpuDiagnosticPort(process.env.PORT);',
    legacyParse: 'Number(process.env.PORT ?? 8793)',
  },
  {
    path: '../browser-harness/endpoint-five-way-tile-webgpu/serve.mjs',
    resolverCall: 'const PORT = resolveEndpointWebgpuDiagnosticPort(process.env.PORT);',
    legacyParse: 'Number(process.env.PORT ?? 8793)',
  },
  {
    path: '../browser-harness/endpoint-poststage-tiled-webgpu/serve.mjs',
    resolverCall: 'const PORT = resolveEndpointWebgpuDiagnosticPort(process.env.PORT, 8795);',
    legacyParse: 'Number(process.env.PORT ?? 8795)',
  },
  {
    path: '../browser-harness/endpoint-embedding-tiled-webgpu/serve.mjs',
    resolverCall: 'const PORT = resolveEndpointWebgpuDiagnosticPort(process.env.PORT, 8796);',
    legacyParse: 'Number(process.env.PORT ?? 8796)',
  },
  {
    path: '../browser-harness/endpoint-embedding-eight-physical-webgpu/serve.mjs',
    resolverCall: 'const PORT = resolveEndpointWebgpuDiagnosticPort(process.env.PORT, 8797);',
    legacyParse: 'Number(process.env.PORT ?? 8797)',
  },
] as const;

function loadSource(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('endpoint WebGPU diagnostic server port preflight', () => {
  it('keeps the compatibility default at 8793', () => {
    expect(DEFAULT_ENDPOINT_WEBGPU_DIAGNOSTIC_PORT).toBe(8793);
    expect(resolveEndpointWebgpuDiagnosticPort(undefined)).toBe(8793);
  });

  it.each([
    [8791, 8791],
    [8795, 8795],
    [8796, 8796],
    [8797, 8797],
  ])('supports a caller-owned compatibility default %i', (defaultPort, expected) => {
    expect(resolveEndpointWebgpuDiagnosticPort(undefined, defaultPort)).toBe(expected);
  });

  it.each([
    ['1', 1],
    ['8793', 8793],
    [' 8793 ', 8793],
    ['65535', 65535],
  ])('accepts numeric environment value %j', (rawPort, expected) => {
    expect(resolveEndpointWebgpuDiagnosticPort(rawPort)).toBe(expected);
  });

  it.each(['', ' ', 'nope', '8793.5', '0', '-1', '65536', 'Infinity', 'NaN'])(
    'rejects invalid environment value %j',
    (rawPort) => {
      expect(() => resolveEndpointWebgpuDiagnosticPort(rawPort)).toThrow(
        'PORT must resolve to an integer between 1 and 65535',
      );
    },
  );

  it.each([0, -1, 8793.5, 65536, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid caller default %j',
    (defaultPort) => {
      expect(() => resolveEndpointWebgpuDiagnosticPort(undefined, defaultPort)).toThrow(
        'PORT must resolve to an integer between 1 and 65535',
      );
    },
  );

  for (const { path: serverPath, resolverCall, legacyParse } of servers) {
    it(`${serverPath} validates PORT before creating the server`, () => {
      const source = loadSource(serverPath);
      expect(source).toContain(
        "import { resolveEndpointWebgpuDiagnosticPort } from '../webgpu-2b-split/server-port.mjs';",
      );
      expect(source).toContain(resolverCall);
      expect(source).not.toContain(legacyParse);
      expect(source.indexOf(resolverCall)).toBeLessThan(source.indexOf('const server = createServer('));
    });
  }

  it('removes the eight-physical server duplicate local range check', () => {
    const source = loadSource(
      '../browser-harness/endpoint-embedding-eight-physical-webgpu/serve.mjs',
    );
    expect(source).not.toContain('if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535)');
    expect(source).not.toContain("throw new Error('PORT must be an integer between 1 and 65535')");
  });
});

describe('split WebGPU diagnostic listener port preflight', () => {
  it('validates the selected port before creating or listening on the Coordinator server', () => {
    const source = loadSource('../browser-harness/webgpu-2b-split/serve.mjs');
    const resolverCall = 'const resolvedPort = resolveWebgpuDiagnosticPort(port, DEFAULT_PORT);';
    const createCall = 'const { server, state } = createSplitHarnessServer();';

    expect(source).toContain("import { resolveWebgpuDiagnosticPort } from './server-port.mjs';");
    expect(source).toContain('const DEFAULT_PORT = 8791;');
    expect(source).toContain('export async function listenSplitHarness({ port = process.env.PORT } = {}) {');
    expect(source).toContain(resolverCall);
    expect(source).toContain("server.listen(resolvedPort, '127.0.0.1', resolvePromise);");
    expect(source).toContain('return { server, state, port: resolvedPort };');
    expect(source).not.toContain('Number(process.env.PORT ?? 8791)');
    expect(source.indexOf(resolverCall)).toBeLessThan(source.indexOf(createCall));
  });

  it.each([0, -1, 8791.5, 65536, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid explicit listener port %j before server creation',
    async (port) => {
      await expect(listenSplitHarness({ port })).rejects.toThrow(
        'PORT must resolve to an integer between 1 and 65535',
      );
    },
  );

  it('rejects an invalid PORT environment value before server creation', async () => {
    const previousPort = process.env.PORT;
    process.env.PORT = 'not-a-port';
    try {
      await expect(listenSplitHarness()).rejects.toThrow(
        'PORT must resolve to an integer between 1 and 65535',
      );
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    }
  });
});
