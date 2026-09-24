import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  resolveEndpointWebgpuDiagnosticPort,
  resolveWebgpuDiagnosticPort,
} from '../browser-harness/webgpu-2b-split/server-port.mjs';

function loadSource(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('shared WebGPU diagnostic server port preflight', () => {
  it('keeps the endpoint resolver as a compatibility alias', () => {
    expect(resolveEndpointWebgpuDiagnosticPort).toBe(resolveWebgpuDiagnosticPort);
  });

  it('preserves the base WebGPU harness default and explicit numeric port semantics', () => {
    expect(resolveWebgpuDiagnosticPort(undefined, 8788)).toBe(8788);
    expect(resolveWebgpuDiagnosticPort('8788', 8788)).toBe(8788);
    expect(resolveWebgpuDiagnosticPort(' 8788 ', 8788)).toBe(8788);
  });

  it.each(['', 'nope', '8788.5', '0', '-1', '65536', 'Infinity', 'NaN'])(
    'rejects invalid base harness port %j',
    (rawPort) => {
      expect(() => resolveWebgpuDiagnosticPort(rawPort, 8788)).toThrow(
        'PORT must resolve to an integer between 1 and 65535',
      );
    },
  );

  it('preflights the base harness port before server creation', () => {
    const source = loadSource('../browser-harness/webgpu-2b/serve.mjs');
    const resolverCall = 'const PORT = resolveWebgpuDiagnosticPort(process.env.PORT, 8788);';
    expect(source).toContain(
      "import { resolveWebgpuDiagnosticPort } from '../webgpu-2b-split/server-port.mjs';",
    );
    expect(source).toContain(resolverCall);
    expect(source).not.toContain('Number(process.env.PORT ?? 8788)');
    expect(source.indexOf(resolverCall)).toBeLessThan(source.indexOf('const server = createServer('));
  });

  it('keeps the base harness loopback-only instead of accepting HOST from the environment', () => {
    const source = loadSource('../browser-harness/webgpu-2b/serve.mjs');
    expect(source).toContain("const HOST = '127.0.0.1';");
    expect(source).toContain('server.listen(PORT, HOST, () => {');
    expect(source).not.toContain('process.env.HOST');
  });
});
