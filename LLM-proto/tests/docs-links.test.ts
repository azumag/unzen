import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('LLM prototype documentation links', () => {
  it('surfaces the 2B two-worker prototype from the LLM-proto entry points', () => {
    const prototypeSpec = readProjectFile('docs/2b-two-worker-prototype.md');
    const readme = readProjectFile('README.md');
    const plan = readProjectFile('PLAN.md');

    expect(prototypeSpec).toContain('2B-class model');
    expect(prototypeSpec).toContain('two-worker split path');
    expect(prototypeSpec).toContain('No browser worker opens a network connection outside');
    expect(prototypeSpec).toContain('TwoWorkerPrototypeRunner');
    expect(prototypeSpec).toContain('PrototypeRunReport');
    expect(readme).toContain('docs/2b-two-worker-prototype.md');
    expect(readme).toContain('tests/two-worker-prototype.test.ts');
    expect(plan).toContain('./docs/2b-two-worker-prototype.md');
  });

  it('surfaces the adaptive chunk dispatcher specification from the LLM-proto entry points', () => {
    const dispatcherSpec = readProjectFile('docs/adaptive-chunk-dispatcher.md');
    const readme = readProjectFile('README.md');
    const plan = readProjectFile('PLAN.md');

    expect(dispatcherSpec).toContain('Keep additional PC load inside a 2-3% sustained budget');
    expect(dispatcherSpec).toContain('uptime, spare capacity, heartbeat quality');
    expect(dispatcherSpec).toContain('src/adaptive-chunk-dispatcher.ts');
    expect(dispatcherSpec).toContain('tests/adaptive-chunk-dispatcher.test.ts');
    expect(dispatcherSpec).toContain('selectedChunkLength');
    expect(dispatcherSpec).toContain('No scheduling path introduces worker-to-worker networking');
    expect(readme).toContain('docs/adaptive-chunk-dispatcher.md');
    expect(readme).toContain('src/adaptive-chunk-dispatcher.ts');
    expect(readme).toContain('tests/adaptive-chunk-dispatcher.test.ts');
    expect(plan).toContain('./docs/adaptive-chunk-dispatcher.md');
  });

  it('surfaces the WebGPU 30B feasibility gate from the LLM-proto entry points', () => {
    const feasibilitySpec = readProjectFile('docs/webgpu-30b-partial-inference-feasibility.md');
    const readme = readProjectFile('README.md');
    const plan = readProjectFile('PLAN.md');

    expect(feasibilitySpec).toContain('30B Partial Inference Feasibility Gate');
    expect(feasibilitySpec).toContain('src/webgpu-30b-feasibility.ts');
    expect(feasibilitySpec).toContain('tests/webgpu-30b-feasibility.test.ts');
    expect(feasibilitySpec).toContain('checkpointTensorShape');
    expect(feasibilitySpec).toContain('AdaptiveChunkDispatcher');
    expect(feasibilitySpec).toContain('Manual Browser/WebGPU Checklist');
    expect(readme).toContain('docs/webgpu-30b-partial-inference-feasibility.md');
    expect(readme).toContain('src/webgpu-30b-feasibility.ts');
    expect(readme).toContain('tests/webgpu-30b-feasibility.test.ts');
    expect(plan).toContain('./docs/webgpu-30b-partial-inference-feasibility.md');
  });

  it('surfaces the checkpoint transfer measurement gate from the LLM-proto entry points', () => {
    const checkpointSpec = readProjectFile('docs/checkpoint-transfer-measurement.md');
    const readme = readProjectFile('README.md');
    const plan = readProjectFile('PLAN.md');

    expect(checkpointSpec).toContain('Checkpoint Transfer Measurement Gate');
    expect(checkpointSpec).toContain('src/checkpoint-transfer-measurement.ts');
    expect(checkpointSpec).toContain('tests/checkpoint-transfer-measurement.test.ts');
    expect(checkpointSpec).toContain('serializationMs');
    expect(checkpointSpec).toContain('observedTransferMs');
    expect(checkpointSpec).toContain('failureReason');
    expect(checkpointSpec).toContain('Manual Browser/WebGPU Measurement Path');
    expect(readme).toContain('docs/checkpoint-transfer-measurement.md');
    expect(readme).toContain('src/checkpoint-transfer-measurement.ts');
    expect(readme).toContain('tests/checkpoint-transfer-measurement.test.ts');
    expect(plan).toContain('./docs/checkpoint-transfer-measurement.md');
  });

  it('surfaces the browser worker retention measurement gate from the LLM-proto entry points', () => {
    const retentionSpec = readProjectFile('docs/browser-worker-retention-measurement.md');
    const readme = readProjectFile('README.md');
    const plan = readProjectFile('PLAN.md');

    expect(retentionSpec).toContain('Browser Worker Retention Measurement Gate');
    expect(retentionSpec).toContain('src/browser-worker-retention.ts');
    expect(retentionSpec).toContain('tests/browser-worker-retention.test.ts');
    expect(retentionSpec).toContain('durationDistribution');
    expect(retentionSpec).toContain('retentionCurve');
    expect(retentionSpec).toContain('retryResumeImpact');
    expect(retentionSpec).toContain('Manual Browser Measurement Path');
    expect(readme).toContain('docs/browser-worker-retention-measurement.md');
    expect(readme).toContain('src/browser-worker-retention.ts');
    expect(readme).toContain('tests/browser-worker-retention.test.ts');
    expect(plan).toContain('./docs/browser-worker-retention-measurement.md');
  });

  it('surfaces the Coordinator prototype gate from the LLM-proto entry points', () => {
    const coordinatorSpec = readProjectFile('docs/coordinator-prototype.md');
    const readme = readProjectFile('README.md');
    const plan = readProjectFile('PLAN.md');

    expect(coordinatorSpec).toContain('Coordinator Prototype Harness');
    expect(coordinatorSpec).toContain('src/coordinator-prototype.ts');
    expect(coordinatorSpec).toContain('tests/coordinator-prototype.test.ts');
    expect(coordinatorSpec).toContain('requestLifecycle');
    expect(coordinatorSpec).toContain('workerHeartbeats');
    expect(coordinatorSpec).toContain('checkpointRelay');
    expect(coordinatorSpec).toContain('retryResumeImpact');
    expect(coordinatorSpec).toContain('Cloudflare Workers Prototype Handoff');
    expect(readme).toContain('docs/coordinator-prototype.md');
    expect(readme).toContain('src/coordinator-prototype.ts');
    expect(readme).toContain('tests/coordinator-prototype.test.ts');
    expect(plan).toContain('./docs/coordinator-prototype.md');
  });

  it('surfaces the Workers Coordinator prototype gate from the LLM-proto entry points', () => {
    const workersSpec = readProjectFile('docs/workers-coordinator-prototype.md');
    const readme = readProjectFile('README.md');
    const plan = readProjectFile('PLAN.md');

    expect(workersSpec).toContain('Workers Coordinator Prototype Gate');
    expect(workersSpec).toContain('src/workers-coordinator-prototype.ts');
    expect(workersSpec).toContain('src/workers-coordinator-miniflare-smoke.ts');
    expect(workersSpec).toContain('src/workers-coordinator-deployed-smoke.ts');
    expect(workersSpec).toContain('src/workers-coordinator-production-observability-canary.ts');
    expect(workersSpec).toContain('src/workers-coordinator-signed-runner-release-gate.ts');
    expect(workersSpec).toContain('src/workers-coordinator-signed-runner-browser-preview.ts');
    expect(workersSpec).toContain('src/workers-coordinator-signed-runner-webgpu-worker-pilot.ts');
    expect(workersSpec).toContain('src/workers-coordinator-webgpu-worker-performance-telemetry.ts');
    expect(workersSpec).toContain('src/workers-coordinator-production-worker-fleet-slo-cost.ts');
    expect(workersSpec).toContain('src/workers-coordinator-publisher-reward-settlement.ts');
    expect(workersSpec).toContain('tests/workers-coordinator-prototype.test.ts');
    expect(workersSpec).toContain('npm run test:workers-smoke');
    expect(workersSpec).toContain('npm run test:workers-load-smoke');
    expect(workersSpec).toContain('npm run test:workers-deployed-smoke');
    expect(workersSpec).toContain('npm run test:workers-production-gate');
    expect(workersSpec).toContain('npm run test:workers-signed-runner-gate');
    expect(workersSpec).toContain('npm run test:workers-signed-runner-browser-preview');
    expect(workersSpec).toContain('npm run test:workers-signed-runner-webgpu-worker-pilot');
    expect(workersSpec).toContain('npm run test:workers-webgpu-telemetry');
    expect(workersSpec).toContain('npm run test:workers-fleet-slo-cost');
    expect(workersSpec).toContain('npm run test:workers-publisher-settlement');
    expect(workersSpec).toContain('requestLifecycle');
    expect(workersSpec).toContain('Durable Object');
    expect(workersSpec).toContain('durableObjectStorageFields');
    expect(workersSpec).toContain('clientTiming');
    expect(workersSpec).toContain('restartPersistence');
    expect(workersSpec).toContain('browserWebSocketTiming');
    expect(workersSpec).toContain('edgePlacement');
    expect(workersSpec).toContain('metricsExport');
    expect(workersSpec).toContain('alertThresholds');
    expect(workersSpec).toContain('canaryRelease');
    expect(workersSpec).toContain('rollbackCheckpointBoundary');
    expect(workersSpec).toContain('coopCoepHeaders');
    expect(workersSpec).toContain('networkBoundary');
    expect(workersSpec).toContain('browserHarness');
    expect(workersSpec).toContain('blockedNonCoordinatorCdnNetworkAttempt');
    expect(workersSpec).toContain('segmentExecution');
    expect(workersSpec).toContain('indexedDbCache');
    expect(workersSpec).toContain('securityBoundaryDuringExecution');
    expect(workersSpec).toContain('segmentLatencyDistribution');
    expect(workersSpec).toContain('indexedDbCacheTiming');
    expect(workersSpec).toContain('checkpointRelayTiming');
    expect(workersSpec).toContain('webGpuDeviceLoss');
    expect(workersSpec).toContain('cpuFallbackRouting');
    expect(workersSpec).toContain('securityBoundaryDuringTelemetry');
    expect(workersSpec).toContain('deviceTierP95Latency');
    expect(workersSpec).toContain('fallbackBudget');
    expect(workersSpec).toContain('cacheWarmupCost');
    expect(workersSpec).toContain('checkpointRelaySpend');
    expect(workersSpec).toContain('userOptInImpact');
    expect(workersSpec).toContain('promoteHoldThresholds');
    expect(workersSpec).toContain('securityBoundaryDuringFleetAggregation');
    expect(workersSpec).toContain('rewardAccrualInputs');
    expect(workersSpec).toContain('checkpointRelayEvidence');
    expect(workersSpec).toContain('signedRunnerExecutionLinkage');
    expect(workersSpec).toContain('abuseDetectionResults');
    expect(workersSpec).toContain('securityBoundaryDuringSettlement');
    expect(workersSpec).toContain('retryResumeImpact');
    expect(workersSpec).toContain('direct worker-to-worker URLs are rejected');
    expect(workersSpec).toContain('authenticated Wrangler preview');
    expect(workersSpec).toContain('publisher reward pilot ledger and payout reconciliation gate');
    expect(readme).toContain('docs/workers-coordinator-prototype.md');
    expect(readme).toContain('src/workers-coordinator-prototype.ts');
    expect(readme).toContain('src/workers-coordinator-miniflare-smoke.ts');
    expect(readme).toContain('src/workers-coordinator-deployed-smoke.ts');
    expect(readme).toContain('src/workers-coordinator-production-observability-canary.ts');
    expect(readme).toContain('src/workers-coordinator-signed-runner-release-gate.ts');
    expect(readme).toContain('src/workers-coordinator-signed-runner-browser-preview.ts');
    expect(readme).toContain('src/workers-coordinator-signed-runner-webgpu-worker-pilot.ts');
    expect(readme).toContain('src/workers-coordinator-webgpu-worker-performance-telemetry.ts');
    expect(readme).toContain('src/workers-coordinator-production-worker-fleet-slo-cost.ts');
    expect(readme).toContain('src/workers-coordinator-publisher-reward-settlement.ts');
    expect(readme).toContain('tests/workers-coordinator-prototype.test.ts');
    expect(readme).toContain('npm run test:workers-smoke');
    expect(readme).toContain('npm run test:workers-load-smoke');
    expect(readme).toContain('npm run test:workers-deployed-smoke');
    expect(readme).toContain('npm run test:workers-production-gate');
    expect(readme).toContain('npm run test:workers-signed-runner-gate');
    expect(readme).toContain('npm run test:workers-signed-runner-browser-preview');
    expect(readme).toContain('npm run test:workers-signed-runner-webgpu-worker-pilot');
    expect(readme).toContain('npm run test:workers-webgpu-telemetry');
    expect(readme).toContain('npm run test:workers-fleet-slo-cost');
    expect(readme).toContain('npm run test:workers-publisher-settlement');
    expect(plan).toContain('./docs/workers-coordinator-prototype.md');
    expect(plan).toContain('Miniflare/workerd');
    expect(plan).toContain('client-side heartbeat timing');
    expect(plan).toContain('authenticated Wrangler preview');
    expect(plan).toContain('production observability canary gate');
    expect(plan).toContain('rollback checkpoint boundary');
    expect(plan).toContain('signed runner release gate');
    expect(plan).toContain('signed runner browser preview gate');
    expect(plan).toContain('signed runner real WebGPU worker pilot gate');
    expect(plan).toContain('WebGPU worker performance / fallback telemetry gate');
    expect(plan).toContain('Production worker fleet SLO / cost gate');
    expect(plan).toContain('Publisher reward and abuse-resistant settlement gate');
    expect(plan).toContain('publisher reward pilot ledger and payout reconciliation gate');
  });
});
