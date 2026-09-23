import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertCancellationOutputPathsDoNotAliasInputs,
} from '../tools/capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs';

function fixture() {
  const dataDir = resolve('/tmp/unzen-eight-physical-data');
  return {
    config: {
      dataDir,
      preflightReport: resolve('/tmp/preflight.json'),
      graphPath: resolve('/tmp/embedding-offset-0.onnx'),
      cancellationOutputPath: resolve('/tmp/cancel-rss.json'),
      boundOutputPath: resolve('/tmp/cancel-rss-bound.json'),
    },
    preflight: {
      payloads: [
        { file: 'payload-0000.bin' },
        { file: 'payload-0001.bin' },
      ],
    },
  };
}

const directAliasCases = [
  ['raw/preflight', 'cancellationOutputPath', 'preflightReport', 'PREFLIGHT_REPORT'],
  ['raw/graph', 'cancellationOutputPath', 'graphPath', 'GRAPH_PATH'],
  ['bound/preflight', 'boundOutputPath', 'preflightReport', 'PREFLIGHT_REPORT'],
  ['bound/graph', 'boundOutputPath', 'graphPath', 'GRAPH_PATH'],
] as const;

const payloadAliasCases = [
  ['raw', 'cancellationOutputPath'],
  ['bound', 'boundOutputPath'],
] as const;

describe('8-physical cancellation RSS output/input alias guard', () => {
  it('accepts ordinary output paths', () => {
    const { config, preflight } = fixture();
    expect(() => assertCancellationOutputPathsDoNotAliasInputs(config, preflight)).not.toThrow();
  });

  it.each(directAliasCases)(
    'rejects %s aliasing',
    (_name, outputKey, inputKey, inputLabel) => {
      const { config, preflight } = fixture();
      config[outputKey] = config[inputKey];
      expect(() => assertCancellationOutputPathsDoNotAliasInputs(config, preflight)).toThrow(
        `must not alias validated input ${inputLabel}`,
      );
    },
  );

  it.each(payloadAliasCases)(
    'rejects %s output aliasing a declared payload',
    (_name, outputKey) => {
      const { config, preflight } = fixture();
      config[outputKey] = resolve(config.dataDir, preflight.payloads[1].file);
      expect(() => assertCancellationOutputPathsDoNotAliasInputs(config, preflight)).toThrow(
        'must not alias validated input preflight.payloads[1]',
      );
    },
  );

  it('runs the guard before output reservation or child capture', () => {
    const source = readFileSync(
      new URL('../tools/capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs', import.meta.url),
      'utf8',
    );
    const runStart = source.indexOf('export async function runBoundCancellationRssCapture');
    const guard = source.indexOf('assertCancellationOutputPathsDoNotAliasInputs(config, preflight);', runStart);
    const reserve = source.indexOf('reserveEvidenceOutput(config.boundOutputPath)', runStart);
    const spawn = source.indexOf('const result = spawnSync(process.execPath', runStart);
    expect(runStart).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(runStart);
    expect(reserve).toBeGreaterThan(guard);
    expect(spawn).toBeGreaterThan(reserve);
  });
});
