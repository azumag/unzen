import {
  inferenceRequestId,
  workerId,
  WorkerTier,
  type Checkpoint,
  type SegmentConfig,
  type WorkerId,
} from './types.js';

export interface PrototypeWorkerMetadata {
  readonly webgpuAdapter: string;
  readonly tier: WorkerTier;
  readonly vramMB: number;
  readonly cachedSegments: readonly number[];
}

export interface PrototypeSegmentReport {
  readonly segmentIndex: number;
  readonly workerId: WorkerId;
  readonly latencyMs: number;
  readonly checkpointBytes: number;
  readonly cacheHit: boolean;
  readonly retryCount: number;
  readonly workerMetadata: PrototypeWorkerMetadata;
}

export interface PrototypeRunReport {
  readonly requestId: string;
  readonly prompt: string;
  readonly referenceText: string;
  readonly splitText: string;
  readonly matchesReference: boolean;
  readonly totalTimeMs: number;
  readonly checkpointRelayBytes: number;
  readonly segments: readonly PrototypeSegmentReport[];
  readonly transport: {
    readonly allowlist: readonly string[];
    readonly connections: readonly string[];
  };
}

export interface PrototypeWorkerOptions {
  readonly id: string;
  readonly segmentIndex: 0 | 1;
  readonly webgpuAdapter: string;
  readonly vramMB: number;
  readonly failFirstRun?: boolean;
}

export interface TwoWorkerPrototypeOptions {
  readonly prompt: string;
  readonly coordinatorUrl?: string;
  readonly cdnUrl?: string;
}

interface SegmentExecutionInput {
  readonly requestId: string;
  readonly prompt: string;
  readonly checkpoint?: Checkpoint;
  readonly coordinatorUrl: string;
  readonly cdnUrl: string;
  readonly transport: AllowlistedPrototypeTransport;
}

interface SegmentExecutionOutput {
  readonly checkpoint?: Checkpoint;
  readonly text?: string;
  readonly latencyMs: number;
  readonly cacheHit: boolean;
  readonly checkpointBytes: number;
}

const DEFAULT_COORDINATOR_URL = 'https://coordinator.unzen.local';
const DEFAULT_CDN_URL = 'https://cdn.unzen.local';

export class AllowlistedPrototypeTransport {
  private readonly connectionLog: string[] = [];

  constructor(private readonly allowedOrigins: readonly string[]) {}

  connect(url: string): void {
    const origin = new URL(url).origin;
    if (!this.allowedOrigins.includes(origin)) {
      throw new Error(`Connection outside prototype allowlist: ${origin}`);
    }
    this.connectionLog.push(origin);
  }

  get allowlist(): readonly string[] {
    return this.allowedOrigins;
  }

  get connections(): readonly string[] {
    return this.connectionLog;
  }

  get connectionCount(): number {
    return this.connectionLog.length;
  }

  connectionsSince(index: number): readonly string[] {
    return this.connectionLog.slice(index);
  }
}

export class SimulatedPrototypeWorker {
  private readonly cachedSegments = new Set<number>();
  private shouldFailFirstRun: boolean;

  readonly id: WorkerId;
  readonly segmentIndex: 0 | 1;
  readonly metadata: PrototypeWorkerMetadata;

  constructor(options: PrototypeWorkerOptions) {
    this.id = workerId(options.id);
    this.segmentIndex = options.segmentIndex;
    this.shouldFailFirstRun = options.failFirstRun ?? false;
    this.metadata = {
      webgpuAdapter: options.webgpuAdapter,
      tier: WorkerTier.TIER_2,
      vramMB: options.vramMB,
      cachedSegments: [],
    };
  }

  async execute(input: SegmentExecutionInput): Promise<SegmentExecutionOutput> {
    input.transport.connect(input.coordinatorUrl);
    input.transport.connect(`${input.cdnUrl}/models/proto-2b-q4/seg-${this.segmentIndex}.bin`);

    if (this.shouldFailFirstRun) {
      this.shouldFailFirstRun = false;
      throw new Error(`Simulated worker loss: ${this.id}`);
    }

    const cacheHit = this.cachedSegments.has(this.segmentIndex);
    this.cachedSegments.add(this.segmentIndex);
    const startedAt = Date.now();

    if (this.segmentIndex === 0) {
      const normalizedPrompt = normalizePrompt(input.prompt);
      const checkpoint = makePrototypeCheckpoint(input.requestId, 0, normalizedPrompt);
      return {
        checkpoint,
        latencyMs: Date.now() - startedAt,
        cacheHit,
        checkpointBytes: checkpoint.hiddenStates.byteLength,
      };
    }

    if (!input.checkpoint) {
      throw new Error('Segment 1 requires a relayed checkpoint');
    }

    input.transport.connect(`${input.coordinatorUrl}/checkpoint/${input.requestId}/0`);
    const hiddenText = bytesToText(input.checkpoint.hiddenStates);
    return {
      text: finalizeText(hiddenText),
      latencyMs: Date.now() - startedAt,
      cacheHit,
      checkpointBytes: input.checkpoint.hiddenStates.byteLength,
    };
  }

  snapshotMetadata(): PrototypeWorkerMetadata {
    return {
      ...this.metadata,
      cachedSegments: [...this.cachedSegments].sort(),
    };
  }
}

export class TwoWorkerPrototypeRunner {
  private readonly transport: AllowlistedPrototypeTransport;
  private readonly segment0: SimulatedPrototypeWorker;
  private readonly segment1Primary: SimulatedPrototypeWorker;
  private readonly segment1Standby: SimulatedPrototypeWorker;
  private requestCounter = 0;

  constructor(options?: {
    readonly transport?: AllowlistedPrototypeTransport;
    readonly segment0?: SimulatedPrototypeWorker;
    readonly segment1Primary?: SimulatedPrototypeWorker;
    readonly segment1Standby?: SimulatedPrototypeWorker;
  }) {
    this.transport = options?.transport ?? new AllowlistedPrototypeTransport([
      DEFAULT_COORDINATOR_URL,
      DEFAULT_CDN_URL,
    ]);
    this.segment0 = options?.segment0 ?? new SimulatedPrototypeWorker({
      id: 'proto-worker-seg0',
      segmentIndex: 0,
      webgpuAdapter: 'mock-webgpu-adapter-a',
      vramMB: 4096,
    });
    this.segment1Primary = options?.segment1Primary ?? new SimulatedPrototypeWorker({
      id: 'proto-worker-seg1-primary',
      segmentIndex: 1,
      webgpuAdapter: 'mock-webgpu-adapter-b',
      vramMB: 4096,
      failFirstRun: true,
    });
    this.segment1Standby = options?.segment1Standby ?? new SimulatedPrototypeWorker({
      id: 'proto-worker-seg1-standby',
      segmentIndex: 1,
      webgpuAdapter: 'mock-webgpu-adapter-c',
      vramMB: 4096,
    });
  }

  async run(options: TwoWorkerPrototypeOptions): Promise<PrototypeRunReport> {
    const startedAt = Date.now();
    const transportStartIndex = this.transport.connectionCount;
    const requestId = `proto-${++this.requestCounter}`;
    const coordinatorUrl = options.coordinatorUrl ?? DEFAULT_COORDINATOR_URL;
    const cdnUrl = options.cdnUrl ?? DEFAULT_CDN_URL;
    const referenceText = runReferencePath(options.prompt);
    const segments: PrototypeSegmentReport[] = [];

    const segment0Result = await this.segment0.execute({
      requestId,
      prompt: options.prompt,
      coordinatorUrl,
      cdnUrl,
      transport: this.transport,
    });
    if (!segment0Result.checkpoint) {
      throw new Error('Segment 0 did not produce a checkpoint');
    }
    segments.push(makeSegmentReport(
      0,
      this.segment0,
      segment0Result,
      0,
    ));

    const segment1Result = await this.executeSegment1WithCheckpoint({
      requestId,
      prompt: options.prompt,
      checkpoint: segment0Result.checkpoint,
      coordinatorUrl,
      cdnUrl,
      transport: this.transport,
    });
    segments.push(segment1Result.report);

    const splitText = segment1Result.output.text ?? '';
    return {
      requestId,
      prompt: options.prompt,
      referenceText,
      splitText,
      matchesReference: splitText === referenceText,
      totalTimeMs: Date.now() - startedAt,
      checkpointRelayBytes: segment0Result.checkpointBytes,
      segments,
      transport: {
        allowlist: this.transport.allowlist,
        connections: this.transport.connectionsSince(transportStartIndex),
      },
    };
  }

  private async executeSegment1WithCheckpoint(
    input: SegmentExecutionInput,
  ): Promise<{ readonly output: SegmentExecutionOutput; readonly report: PrototypeSegmentReport }> {
    let retryCount = 0;

    try {
      const output = await this.segment1Primary.execute(input);
      return {
        output,
        report: makeSegmentReport(1, this.segment1Primary, output, retryCount),
      };
    } catch {
      retryCount++;
      const output = await this.segment1Standby.execute(input);
      return {
        output,
        report: makeSegmentReport(1, this.segment1Standby, output, retryCount),
      };
    }
  }
}

export const TWO_WORKER_PROTOTYPE_SEGMENTS: readonly SegmentConfig[] = [
  {
    index: 0,
    layerStart: 0,
    layerEnd: 11,
    modelWeightHash: 'sha256:proto-2b-q4-seg0',
    estimatedVramMB: 4096,
  },
  {
    index: 1,
    layerStart: 12,
    layerEnd: 23,
    modelWeightHash: 'sha256:proto-2b-q4-seg1',
    estimatedVramMB: 4096,
  },
];

export function runReferencePath(prompt: string): string {
  return finalizeText(normalizePrompt(prompt));
}

function makeSegmentReport(
  segmentIndex: 0 | 1,
  worker: SimulatedPrototypeWorker,
  output: SegmentExecutionOutput,
  retryCount: number,
): PrototypeSegmentReport {
  return {
    segmentIndex,
    workerId: worker.id,
    latencyMs: output.latencyMs,
    checkpointBytes: output.checkpointBytes,
    cacheHit: output.cacheHit,
    retryCount,
    workerMetadata: worker.snapshotMetadata(),
  };
}

function makePrototypeCheckpoint(
  requestId: string,
  segmentIndex: number,
  hiddenText: string,
): Checkpoint {
  return {
    requestId: inferenceRequestId(requestId),
    segmentIndex,
    hiddenStates: textToBytes(hiddenText),
    metadata: {
      shape: [1, hiddenText.length, 1],
      dtype: 'uint8',
      sequenceLength: hiddenText.length,
      timestamp: Date.now(),
    },
  };
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').toUpperCase();
}

function finalizeText(hiddenText: string): string {
  return `proto-2b:${hiddenText}`;
}

function textToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
