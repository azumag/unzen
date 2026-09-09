import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const policyPath = join(projectRoot, 'policy', 'cloudflare-wasm-adoption.json');
const decisionDocPath = join(projectRoot, 'docs', 'cloudflare-wasm-adoption-decision.md');

type WasmAdoptionPolicy = {
  schemaVersion: string;
  decision: string;
  decisionIssue: number;
  parentIssue: number;
  productionReplacementAllowed: boolean;
  defaultInstantiationScope: string;
  requiredEvidence: string[];
  allowedScopes: string[];
  blockedScopes: string[];
  remoteUnknowns: string[];
  revisitTriggers: string[];
  pinnedEvidence: {
    compatibilityDate: string;
    wranglerVersion: string;
    packagingFixture: { bytes: number; sha256: string };
    geometryFixture: { bytes: number; sha256: string };
    steps: Array<{ issue: number; pullRequest: number; result: string }>;
  };
};

async function readPolicy(): Promise<WasmAdoptionPolicy> {
  return JSON.parse(await readFile(policyPath, 'utf8')) as WasmAdoptionPolicy;
}

describe('Cloudflare Workers Wasm adoption policy', () => {
  it('pins a limited-adoption decision and forbids production replacement', async () => {
    const policy = await readPolicy();
    expect(policy.schemaVersion).toBe('1.0.0');
    expect(policy.decision).toBe('limited-adoption');
    expect(policy.decisionIssue).toBe(312);
    expect(policy.parentIssue).toBe(301);
    expect(policy.productionReplacementAllowed).toBe(false);
    expect(policy.defaultInstantiationScope).toBe('module');
  });

  it('requires parity, fail-close input handling, and pinned identities before adoption', async () => {
    const policy = await readPolicy();
    expect(policy.requiredEvidence).toEqual(expect.arrayContaining([
      'pure-deterministic-kernel',
      'javascript-reference',
      'differential-tests',
      'fail-closed-input-domain-preflight',
      'pinned-wasm-identity',
      'pinned-toolchain',
    ]));
    expect(policy.allowedScopes).toEqual(expect.arrayContaining([
      'small-integer-verification-kernel',
      'small-binary-format-verification-kernel',
      'isolated-worker-canary',
    ]));
  });

  it('keeps production orchestration and performance-only migration blocked', async () => {
    const policy = await readPolicy();
    expect(policy.blockedScopes).toEqual(expect.arrayContaining([
      'production-validator-replacement',
      'coordinator-stateful-orchestration',
      'network-or-storage-orchestration',
      'performance-only-adoption-without-production-evidence',
      'rust-c-toolchain-wide-migration',
      'browser-webgpu-architecture-substitute',
    ]));
  });

  it('carries remote-only unknowns and explicit revisit triggers forward', async () => {
    const policy = await readPolicy();
    expect(policy.remoteUnknowns).toEqual([
      'cloudflare-production-runtime-identity',
      'cloudflare-production-cold-warm-latency',
      'cloudflare-production-isolate-restart-behavior',
    ]);
    expect(policy.revisitTriggers).toEqual(expect.arrayContaining([
      'explicitly-authorized-remote-canary-evidence',
      'measured-production-cpu-hotspot-with-wasm-suitable-pure-kernel',
      'maintainable-source-toolchain-proposal-with-reproducible-build',
    ]));
  });

  it('pins the exact toolchain and Wasm evidence collected in Steps 1-5A', async () => {
    const policy = await readPolicy();
    expect(policy.pinnedEvidence.compatibilityDate).toBe('2026-08-06');
    expect(policy.pinnedEvidence.wranglerVersion).toBe('4.129.1');
    expect(policy.pinnedEvidence.packagingFixture).toEqual({
      bytes: 41,
      sha256: 'f61fd62f57c41269c3c23f360eeaf1090b1db9c38651106674d48bc65dba88ba',
    });
    expect(policy.pinnedEvidence.geometryFixture).toEqual({
      bytes: 109,
      sha256: '6f311dd115e63448a0e0bf11b12fa29cc1c851112f38732b58ceebc09ba548aa',
    });
    expect(policy.pinnedEvidence.steps.map(({ issue, pullRequest }) => [issue, pullRequest])).toEqual([
      [302, 303],
      [304, 305],
      [306, 307],
      [308, 309],
      [310, 311],
    ]);
  });

  it('keeps the ADR aligned with the machine-readable policy boundary', async () => {
    const doc = await readFile(decisionDocPath, 'utf8');
    for (const marker of [
      'limited-adoption',
      'productionReplacementAllowed: false',
      'module-scope',
      'JavaScript reference',
      'differential test',
      'fail-close',
      'Phase B',
      '未確認',
      'policy/cloudflare-wasm-adoption.json',
    ]) {
      expect(doc).toContain(marker);
    }
  });
});
