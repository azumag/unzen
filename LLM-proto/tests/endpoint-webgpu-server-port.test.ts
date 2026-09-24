import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENDPOINT_WEBGPU_DIAGNOSTIC_PORT,
  resolveEndpointWebgpuDiagnosticPort,
} from '../browser-harness/webgpu-2b-split/server-port.mjs';

const servers = [
  '../browser-harness/endpoint-tile-webgpu/serve.mjs',
  '../browser-harness/endpoint-five-way-tile-webgpu/serve.mjs',
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

  for (const serverPath of servers) {
    it(`${serverPath} validates PORT before creating the server`, () => {
      const source = loadSource(serverPath);
      expect(source).toContain(
        "import { resolveEndpointWebgpuDiagnosticPort } from '../webgpu-2b-split/server-port.mjs';",
      );
      expect(source).toContain(
        'const PORT = resolveEndpointWebgpuDiagnosticPort(process.env.PORT);',
      );
      expect(source).not.toContain('Number(process.env.PORT ?? 8793)');
      expect(source.indexOf('const PORT = resolveEndpointWebgpuDiagnosticPort(process.env.PORT);')).toBeLessThan(
        source.indexOf('const server = createServer('),
      );
    });
  }
});
