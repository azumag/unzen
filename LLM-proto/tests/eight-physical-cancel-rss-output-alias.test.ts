import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

function filesystemFixture() {
  const root = mkdtempSync(join(tmpdir(), 'unzen-cancel-rss-alias-test-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const preflightReport = join(root, 'preflight.json');
  const graphPath = join(root, 'embedding-offset-0.onnx');
  const payloadPath = join(dataDir, 'payload-0000.bin');
  writeFileSync(preflightReport, '{}\n');
  writeFileSync(graphPath, 'graph');
  writeFileSync(payloadPath, 'payload');
  return {
    root,
    payloadPath,
    config: {
      dataDir,
      preflightReport,
      graphPath,
      cancellationOutputPath: join(root, 'cancel-rss.json'),
      boundOutputPath: join(root, 'cancel-rss-bound.json'),
    },
    preflight: {
      payloads: [{ file: 'payload-0000.bin' }],
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

  it('rejects an existing final-output symlink before child capture', () => {
    const { root, config, preflight } = filesystemFixture();
    try {
      symlinkSync(config.graphPath, config.cancellationOutputPath);
      expect(() => assertCancellationOutputPathsDoNotAliasInputs(config, preflight)).toThrow(
        'CANCELLATION_OUTPUT_JSON must not be an existing symlink',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a hard-link output alias of a validated payload', () => {
    const { root, payloadPath, config, preflight } = filesystemFixture();
    try {
      linkSync(payloadPath, config.cancellationOutputPath);
      expect(() => assertCancellationOutputPathsDoNotAliasInputs(config, preflight)).toThrow(
        'CANCELLATION_OUTPUT_JSON must not alias validated input preflight.payloads[0]',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an output reached through a symlinked parent directory', () => {
    const { root, config, preflight } = filesystemFixture();
    try {
      const aliasDataDir = join(root, 'alias-data');
      symlinkSync(config.dataDir, aliasDataDir, 'dir');
      config.cancellationOutputPath = join(aliasDataDir, 'payload-0000.bin');
      expect(() => assertCancellationOutputPathsDoNotAliasInputs(config, preflight)).toThrow(
        'CANCELLATION_OUTPUT_JSON must not alias validated input preflight.payloads[0]',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps overwrite compatibility for an unrelated existing regular output', () => {
    const { root, config, preflight } = filesystemFixture();
    try {
      writeFileSync(config.cancellationOutputPath, 'old diagnostic output');
      expect(() => assertCancellationOutputPathsDoNotAliasInputs(config, preflight)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
