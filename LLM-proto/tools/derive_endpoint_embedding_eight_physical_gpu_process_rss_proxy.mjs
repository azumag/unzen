#!/usr/bin/env node
/**
 * Derive a Chrome GPU-process RSS proxy from already-validated 8-physical
 * page-teardown cancellation evidence.
 *
 * This is deliberately an OS process metric. It is not GPU device-memory,
 * WebGPU allocation, driver working-set, or allocator reclamation evidence.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readStableCancellationRssEvidence,
  validateCancellationRssEvidence,
} from './verify_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs';

const GPU_ROLE = 'gpu-process';

function requireGpuProcessRole(snapshot, label) {
  const role = snapshot?.roles?.[GPU_ROLE];
  if (!role || typeof role !== 'object' || Array.isArray(role)) {
    throw new Error(`${label} must contain a ${GPU_ROLE} role`);
  }
  if (role.processCount !== 1) {
    throw new Error(`${label}.${GPU_ROLE}.processCount must be exactly 1`);
  }
  if (!Number.isSafeInteger(role.rssKiB) || role.rssKiB < 0) {
    throw new Error(`${label}.${GPU_ROLE}.rssKiB must be a non-negative safe integer`);
  }
  return {
    processCount: role.processCount,
    rssKiB: role.rssKiB,
  };
}

function point(label, snapshot, extra = {}) {
  return {
    label,
    ...extra,
    ...requireGpuProcessRole(snapshot, label),
  };
}

export function deriveGpuProcessRssProxy(sourceEvidence) {
  const evidence = validateCancellationRssEvidence(sourceEvidence);
  const expectedTargetPhase = `executing embedding tile ${evidence.cancellation.targetTile}`;
  const targetPhasePeak = evidence.measurement.phasePeaks.find(
    (entry) => entry.phase === expectedTargetPhase,
  );
  if (!targetPhasePeak) {
    throw new Error(`validated source evidence is missing ${expectedTargetPhase}`);
  }

  const after = evidence.measurement.afterDocumentCancellation;
  const points = [
    point('baseline-about-blank', evidence.measurement.baseline),
    point('global-total-rss-peak-snapshot', evidence.measurement.globalPeak),
    point('cancellation-target-phase-total-rss-peak', targetPhasePeak, {
      phase: expectedTargetPhase,
    }),
    point('immediately-before-cancellation', evidence.measurement.immediatelyBeforeCancellation),
    point('post-cancel-immediate', after.immediateAfterBlankReady),
    point('post-cancel-total-rss-peak', after.peakDuringSettle),
    point('post-cancel-total-rss-minimum', after.minimumDuringSettle),
    point('post-cancel-final', after.finalAfterSettle),
  ];
  if (after.firstAtOrBelowBaseline !== null) {
    points.push(point('first-total-rss-at-or-below-baseline', after.firstAtOrBelowBaseline, {
      elapsedMs: after.firstAtOrBelowBaseline.elapsedMs,
    }));
  }

  const baselineRssKiB = points[0].rssKiB;
  const pointsWithDelta = points.map((entry) => ({
    ...entry,
    deltaFromBaselineKiB: entry.rssKiB - baselineRssKiB,
  }));
  const observedPointPeak = pointsWithDelta.reduce((current, candidate) => (
    candidate.rssKiB > current.rssKiB ? candidate : current
  ));
  const postCancelMinimum = pointsWithDelta.find(
    (entry) => entry.label === 'post-cancel-total-rss-minimum',
  );
  const postCancelFinal = pointsWithDelta.find(
    (entry) => entry.label === 'post-cancel-final',
  );
  const peakExcessKiB = observedPointPeak.rssKiB - baselineRssKiB;
  const peakExcessRecoveryRatioAtPostCancelMinimum = peakExcessKiB > 0
    ? (observedPointPeak.rssKiB - postCancelMinimum.rssKiB) / peakExcessKiB
    : null;

  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-endpoint-embedding-eight-physical-webgpu-gpu-process-rss-proxy',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'derived-os-gpu-process-rss-proxy',
    sourceEvidence: {
      schemaVersion: evidence.schemaVersion,
      kind: evidence.kind,
      evidenceLevel: evidence.evidenceLevel,
      capturedAtUtc: evidence.capturedAtUtc,
      targetTile: evidence.cancellation.targetTile,
      expectedPhase: expectedTargetPhase,
      chromeVersion: evidence.environment.chromeVersion,
      cdpBrowser: evidence.environment.cdpBrowser,
      platform: evidence.environment.platform,
      osRelease: evidence.environment.osRelease,
      sampleIntervalMs: evidence.measurement.sampleIntervalMs,
      sampleCount: evidence.measurement.sampleCount,
    },
    measurement: {
      metric: 'Chrome gpu-process resident-set-size proxy',
      unit: 'KiB',
      processRole: GPU_ROLE,
      processCountContract: 'exactly one Chrome process classified by --type=gpu-process at every reported observation point',
      semantics: 'OS RSS for the launched Chrome GPU process only; not GPU device-memory or WebGPU/driver allocation accounting',
      points: pointsWithDelta,
      baselineRssKiB,
      observedPointPeak: {
        label: observedPointPeak.label,
        rssKiB: observedPointPeak.rssKiB,
        deltaFromBaselineKiB: observedPointPeak.deltaFromBaselineKiB,
      },
      postCancelMinimumRssKiB: postCancelMinimum.rssKiB,
      postCancelMinimumDeltaFromBaselineKiB: postCancelMinimum.deltaFromBaselineKiB,
      postCancelFinalRssKiB: postCancelFinal.rssKiB,
      postCancelFinalDeltaFromBaselineKiB: postCancelFinal.deltaFromBaselineKiB,
      peakExcessRecoveryRatioAtPostCancelMinimum,
      postCancelMinimumAtOrBelowBaseline: postCancelMinimum.rssKiB <= baselineRssKiB,
    },
    conclusion: 'The trusted cancellation capture contains a single Chrome gpu-process role at every selected observation point, allowing a deterministic OS-RSS proxy envelope to be derived. This is supporting diagnostic evidence only and cannot establish GPU device-memory peak or allocator reclamation.',
    limitations: [
      'Chrome gpu-process RSS is host OS resident memory accounting, not GPU VRAM, WebGPU buffer allocation, driver heap, or device-local working-set accounting.',
      'The source capture samples process RSS at intervals and can miss shorter-lived GPU-process RSS peaks.',
      'The source global/phase peaks are selected by total Chrome-tree RSS, not by gpu-process RSS; observedPointPeak is therefore only the maximum among persisted observation points.',
      'Shared mappings can be charged to process RSS, and unified-memory systems cannot separate CPU-resident and GPU-visible pages using this metric.',
      'A post-cancellation RSS decline does not prove ORT/WebGPU/driver allocator reclamation; Chrome and the driver may retain reusable allocations or caches.',
      'This derived report does not select the 8-physical layout or establish decoder/KV/checkpoint full-model equivalence or resume correctness.',
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) {
      throw new Error('usage: derive_endpoint_embedding_eight_physical_gpu_process_rss_proxy.mjs CANCELLATION_RSS_JSON');
    }
    const evidence = readStableCancellationRssEvidence(process.argv[2]);
    console.log(JSON.stringify(deriveGpuProcessRssProxy(evidence), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
