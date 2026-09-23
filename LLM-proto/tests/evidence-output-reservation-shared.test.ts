import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertEvidenceOutputPathIdentity as legacyAssertIdentity,
  cleanupReservedEvidenceOutput as legacyCleanup,
  reserveEvidenceOutput as legacyReserve,
} from '../tools/capture_endpoint_embedding_webgpu_runtime.mjs';
import {
  assertEvidenceOutputPathIdentity,
  cleanupReservedEvidenceOutput,
  reserveEvidenceOutput,
} from '../tools/evidence_output_reservation.mjs';

describe('shared evidence output reservation helper', () => {
  it('keeps the endpoint embedding exports API-compatible', () => {
    expect(legacyReserve).toBe(reserveEvidenceOutput);
    expect(legacyAssertIdentity).toBe(assertEvidenceOutputPathIdentity);
    expect(legacyCleanup).toBe(cleanupReservedEvidenceOutput);
  });

  it('lets post-stage RSS capture depend on the neutral helper directly', () => {
    const source = readFileSync(
      new URL('../tools/capture_endpoint_poststage_webgpu_process_rss.mjs', import.meta.url),
      'utf8',
    );
    expect(source).toContain("from './evidence_output_reservation.mjs';");
    expect(source).not.toContain("from './capture_endpoint_embedding_webgpu_runtime.mjs';");
  });
});
