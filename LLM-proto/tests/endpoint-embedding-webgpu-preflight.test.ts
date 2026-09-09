import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseChromeVersion,
  validateChromeHostProbeIdentity,
  verifyPreparedFileIdentity,
} from '../tools/preflight_endpoint_embedding_webgpu_capture.mjs';

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

describe('endpoint embedding WebGPU capture preflight file identity', () => {
  it('accepts an exact regular file without loading it as one large buffer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-endpoint-embedding-preflight-test-'));
    const path = join(dir, 'payload.bin');
    const content = Buffer.from('endpoint embedding preflight\n');
    try {
      writeFileSync(path, content);
      await expect(verifyPreparedFileIdentity(path, {
        bytes: content.length,
        sha256: sha256(content),
      }, 'test payload')).resolves.toEqual({
        fileName: 'payload.bin',
        bytes: content.length,
        sha256: sha256(content),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on byte-length or digest drift', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-endpoint-embedding-preflight-test-'));
    const path = join(dir, 'payload.bin');
    const content = Buffer.from('pinned bytes');
    try {
      writeFileSync(path, content);
      await expect(verifyPreparedFileIdentity(path, {
        bytes: content.length + 1,
        sha256: sha256(content),
      }, 'test payload')).rejects.toThrow('byte length mismatch');
      await expect(verifyPreparedFileIdentity(path, {
        bytes: content.length,
        sha256: '0'.repeat(64),
      }, 'test payload')).rejects.toThrow('SHA-256 mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects symlinked prepared artifacts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-endpoint-embedding-preflight-test-'));
    const realPath = join(dir, 'real.bin');
    const linkPath = join(dir, 'payload.bin');
    const content = Buffer.from('pinned bytes');
    try {
      writeFileSync(realPath, content);
      symlinkSync(realPath, linkPath);
      await expect(verifyPreparedFileIdentity(linkPath, {
        bytes: content.length,
        sha256: sha256(content),
      }, 'test payload')).rejects.toThrow('must not be a symlink');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('endpoint embedding WebGPU capture preflight Chrome parsing', () => {
  it('extracts the exact four-part Chrome version while retaining raw product identity', () => {
    expect(parseChromeVersion('Google Chrome 152.0.7977.83\n')).toEqual({
      raw: 'Google Chrome 152.0.7977.83',
      version: '152.0.7977.83',
    });
    expect(parseChromeVersion('Chromium 151.0.7890.12')).toEqual({
      raw: 'Chromium 151.0.7890.12',
      version: '151.0.7890.12',
    });
    expect(parseChromeVersion('Google Chrome for Testing 153.0.8000.1')).toEqual({
      raw: 'Google Chrome for Testing 153.0.8000.1',
      version: '153.0.8000.1',
    });
  });

  it('fails closed when the executable output is not a supported Chrome product identity', () => {
    expect(() => parseChromeVersion('Mozilla Firefox 152.0.7977.83')).toThrow('Google Chrome/Chromium');
    expect(() => parseChromeVersion('Browser 152.0.7977.83')).toThrow('Google Chrome/Chromium');
  });

  it('fails closed when a four-part browser version is unavailable', () => {
    expect(() => parseChromeVersion('Google Chrome dev')).toThrow('four-part version');
    expect(() => parseChromeVersion('')).toThrow('non-empty string');
  });
});

describe('endpoint embedding WebGPU capture preflight Chrome/host-probe binding', () => {
  it('accepts a host-probe UA with the selected Chrome executable major', () => {
    const hostProbe = {
      userAgent: 'Mozilla/5.0 AppleWebKit/537.36 HeadlessChrome/152.0.0.0 Safari/537.36',
    };
    expect(validateChromeHostProbeIdentity({
      raw: 'Google Chrome 152.0.7977.83',
      version: '152.0.7977.83',
    }, hostProbe)).toBe(hostProbe);
  });

  it('fails closed before payload hashing when the launched host-probe Chrome major drifts', () => {
    expect(() => validateChromeHostProbeIdentity({
      raw: 'Google Chrome 152.0.7977.83',
      version: '152.0.7977.83',
    }, {
      userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
    })).toThrow('Chrome executable/host-probe major mismatch');
  });

  it('fails closed on malformed executable or host-probe identity', () => {
    expect(() => validateChromeHostProbeIdentity({ version: '152' }, {
      userAgent: 'Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36',
    })).toThrow('four-part version');
    expect(() => validateChromeHostProbeIdentity({ version: '152.0.7977.83' }, {
      userAgent: 'not-a-browser',
    })).toThrow('must identify Chrome/HeadlessChrome');
  });
});

it('keeps the real preflight bound to the pinned manifest, selected Chrome, and every prepared graph/payload', () => {
  const source = readFileSync(
    new URL('../tools/preflight_endpoint_embedding_webgpu_capture.mjs', import.meta.url),
    'utf8',
  );
  expect(source).toContain('validateEndpointEmbeddingWebGpuManifest(manifest)');
  expect(source).toContain('validateChromeHostProbeIdentity(chrome, hostProbe)');
  expect(source).toContain('Object.entries(EXPECTED.graphVariants)');
  expect(source).toContain('for (const artifact of EXPECTED.physicalArtifacts)');
  expect(source).toContain("decisionStatus: 'diagnostic-only'");
  expect(source).toContain('does not constitute browser/WebGPU execution evidence');
  expect(source.indexOf('validateChromeHostProbeIdentity(chrome, hostProbe)'))
    .toBeLessThan(source.indexOf('Object.entries(EXPECTED.graphVariants)'));
});
