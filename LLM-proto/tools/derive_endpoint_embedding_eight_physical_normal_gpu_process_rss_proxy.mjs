#!/usr/bin/env node
/**
 * Derive a Chrome GPU-process RSS proxy from already-validated 8-physical
 * normal-completion process-RSS evidence.
 *
 * This is deliberately an OS process metric. It is not GPU device-memory,
 * WebGPU allocation, driver working-set, or allocator reclamation evidence.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readStableProcessRssEvidence,
  validateProcessRssEvidence,
} from './verify_endpoint_embedding_eight_physical_webgpu_process_rss.mjs';

const GPU_ROLE = 'gpu-process';
const CONTROL_PHASES = new Set([
  'baseline-about-blank',
  'post-report-release-settle',
  'post-teardown-about-blank',
]);

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

function withBaselineDelta(points) {
  const baselineRssKiB = points[0].rssKiB;
  return {
    baselineRssKiB,
    points: points.map((entry) => ({
      ...entry,
      deltaFromBaselineKiB: entry.rssKiB - baselineRssKiB,
    })),
  };
}

function recoveryRatio(peakRssKiB, baselineRssKiB, recoveredRssKiB) {
  const peakExcessKiB = peakRssKiB - baselineRssKiB;
  return peakExcessKiB > 0
    ? (peakRssKiB - recoveredRssKiB) / peakExcessKiB
    : null;
}

function runtimeIdentity(runtimeReport) {
  return {
    onnxruntimeWebVersion: runtimeReport.onnxruntimeWebVersion,
    manifestPayloadSetSha256: runtimeReport.manifestPayloadSetSha256,
    graph: {
      file: runtimeReport.verifiedGraph.file,
      bytes: runtimeReport.verifiedGraph.bytes,
      sha256: runtimeReport.verifiedGraph.sha256,
    },
    physicalArtifacts: runtimeReport.verifiedPhysicalArtifacts.map((artifact) => ({
      index: artifact.index,
      file: artifact.file,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    })),
  };
}

export function deriveNormalGpuProcessRssProxy(sourceEvidence) {
  const evidence = validateProcessRssEvidence(sourceEvidence);
  const measurement = evidence.measurement;
  const afterRelease = measurement.afterAllSessionReleaseApisReturned;
  const afterTeardown = measurement.afterDocumentTeardown;

  const points = [
    point('baseline-about-blank', measurement.baseline),
    point('global-total-rss-peak-snapshot', measurement.globalPeak),
  ];

  for (const entry of measurement.phasePeaks) {
    if (CONTROL_PHASES.has(entry.phase)) continue;
    points.push(point('execution-phase-total-rss-peak', entry, { phase: entry.phase }));
  }

  points.push(
    point('post-release-immediate', afterRelease.immediate),
    point('post-release-total-rss-peak', afterRelease.peakDuringSettle),
    point('post-release-final', afterRelease.finalAfterSettle),
    point('post-teardown-immediate', afterTeardown.immediateAfterBlankReady),
    point('post-teardown-total-rss-peak', afterTeardown.peakDuringSettle),
    point('post-teardown-total-rss-minimum', afterTeardown.minimumDuringSettle),
    point('post-teardown-final', afterTeardown.finalAfterSettle),
  );
  if (afterTeardown.firstAtOrBelowBaseline !== null) {
    points.push(point('first-total-rss-at-or-below-baseline', afterTeardown.firstAtOrBelowBaseline, {
      elapsedMs: afterTeardown.firstAtOrBelowBaseline.elapsedMs,
    }));
  }

  const { baselineRssKiB, points: pointsWithDelta } = withBaselineDelta(points);
  const observedPointPeak = pointsWithDelta.reduce((current, candidate) => (
    candidate.rssKiB > current.rssKiB ? candidate : current
  ));
  const byLabel = new Map(pointsWithDelta.map((entry) => [entry.label, entry]));
  const releaseFinal = byLabel.get('post-release-final');
  const teardownMinimum = byLabel.get('post-teardown-total-rss-minimum');
  const teardownFinal = byLabel.get('post-teardown-final');

  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-endpoint-embedding-eight-physical-webgpu-normal-gpu-process-rss-proxy',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'derived-os-gpu-process-rss-proxy',
    sourceEvidence: {
      schemaVersion: evidence.schemaVersion,
      kind: evidence.kind,
      evidenceLevel: evidence.evidenceLevel,
      capturedAtUtc: evidence.capturedAtUtc,
      chromeVersion: evidence.environment.chromeVersion,
      cdpBrowser: evidence.environment.cdpBrowser,
      platform: evidence.environment.platform,
      osRelease: evidence.environment.osRelease,
      sampleIntervalMs: measurement.sampleIntervalMs,
      sampleCount: measurement.sampleCount,
      postReportSettleMs: measurement.postReportSettleMs,
      postDocumentTeardownSettleMs: measurement.postDocumentTeardownSettleMs,
      runtimeIdentity: runtimeIdentity(evidence.runtimeReport),
    },
    measurement: {
      metric: 'Chrome gpu-process resident-set-size proxy',
      unit: 'KiB',
      processRole: GPU_ROLE,
      processCountContract: 'exactly one Chrome process classified by --type=gpu-process at every reported observation point',
      semantics: 'OS RSS for the launched Chrome GPU-process role only; not GPU device-memory or WebGPU/driver allocation accounting',
      points: pointsWithDelta,
      baselineRssKiB,
      observedPointPeak: {
        label: observedPointPeak.label,
        ...(observedPointPeak.phase ? { phase: observedPointPeak.phase } : {}),
        rssKiB: observedPointPeak.rssKiB,
        deltaFromBaselineKiB: observedPointPeak.deltaFromBaselineKiB,
      },
      postReleaseFinalRssKiB: releaseFinal.rssKiB,
      postReleaseFinalDeltaFromBaselineKiB: releaseFinal.deltaFromBaselineKiB,
      peakExcessRecoveryRatioAtPostReleaseFinal: recoveryRatio(
        observedPointPeak.rssKiB,
        baselineRssKiB,
        releaseFinal.rssKiB,
      ),
      postReleaseFinalAtOrBelowBaseline: releaseFinal.rssKiB <= baselineRssKiB,
      postTeardownMinimumRssKiB: teardownMinimum.rssKiB,
      postTeardownMinimumDeltaFromBaselineKiB: teardownMinimum.deltaFromBaselineKiB,
      peakExcessRecoveryRatioAtPostTeardownMinimum: recoveryRatio(
        observedPointPeak.rssKiB,
        baselineRssKiB,
        teardownMinimum.rssKiB,
      ),
      postTeardownMinimumAtOrBelowBaseline: teardownMinimum.rssKiB <= baselineRssKiB,
      postTeardownFinalRssKiB: teardownFinal.rssKiB,
      postTeardownFinalDeltaFromBaselineKiB: teardownFinal.deltaFromBaselineKiB,
    },
    conclusion: 'The trusted normal-completion capture contains a single Chrome gpu-process role at every selected observation point, allowing a deterministic OS-RSS proxy envelope across session release and document teardown to be derived. This is supporting diagnostic evidence only and cannot establish GPU device-memory peak or allocator reclamation.',
    limitations: [
      'Chrome gpu-process RSS is host OS resident memory accounting, not GPU VRAM, WebGPU buffer allocation, driver heap, or device-local working-set accounting.',
      'The source capture samples process RSS at intervals and can miss shorter-lived GPU-process RSS peaks.',
      'The source global/phase peaks are selected by total Chrome-tree RSS, not by gpu-process RSS; observedPointPeak is therefore only the maximum among persisted observation points.',
      'The normal capture persists role aggregates but not GPU-process PIDs, so this report cannot prove that the same GPU-process instance survived across all observation points.',
      'The normal capture persists release immediate/peak/final but no release-window minimum; this report does not invent a release minimum.',
      'Shared mappings can be charged to process RSS, and unified-memory systems cannot separate CPU-resident and GPU-visible pages using this metric.',
      'A post-release or post-teardown RSS decline does not prove ORT/WebGPU/driver allocator reclamation; Chrome and the driver may retain reusable allocations or caches.',
      'This derived report does not select the 8-physical layout or establish decoder/KV/checkpoint full-model equivalence or resume correctness.',
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) {
      throw new Error('usage: derive_endpoint_embedding_eight_physical_normal_gpu_process_rss_proxy.mjs PROCESS_RSS_JSON');
    }
    const evidence = readStableProcessRssEvidence(process.argv[2]);
    console.log(JSON.stringify(deriveNormalGpuProcessRssProxy(evidence), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
