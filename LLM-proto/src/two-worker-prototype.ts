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

interface ValidatedSegmentExecutionInput {
  readonly requestId: string;
  readonly prompt: string;
  readonly checkpointHiddenStates?: Uint8Array;
  readonly coordinatorUrl: string;
  readonly cdnUrl: string;
  readonly transport: AllowlistedPrototypeTransport;
}

interface TwoWorkerPrototypeRunnerDependencies {
  readonly transport?: AllowlistedPrototypeTransport;
  readonly segment0?: SimulatedPrototypeWorker;
  readonly segment1Primary?: SimulatedPrototypeWorker;
  readonly segment1Standby?: SimulatedPrototypeWorker;
}

const DEFAULT_COORDINATOR_URL = 'https://coordinator.unzen.local';
const DEFAULT_CDN_URL = 'https://cdn.unzen.local';

export class AllowlistedPrototypeTransport {
  private readonly connectionLog: string[] = [];
  private readonly allowedOrigins: readonly string[];

  constructor(allowedOrigins: readonly string[]) {
    if (!Array.isArray(allowedOrigins)) {
      throw new Error('prototype allowedOrigins must be an array');
    }
    const canonicalOrigins = (allowedOrigins as readonly unknown[]).map((value, index) => {
      const validatedValue = validatePrototypeUrlString(
        value,
        `prototype allowlist URL at index ${index}`,
      );
      let parsed: URL;
      try {
        parsed = new URL(validatedValue);
      } catch {
        throw new Error(`Invalid prototype allowlist URL at index ${index}: ${validatedValue}`);
      }
      if (parsed.origin === 'null') {
        throw new Error(`Prototype allowlist URL must have a network origin: ${validatedValue}`);
      }
      return parsed.origin;
    });
    this.allowedOrigins = Object.freeze([...new Set(canonicalOrigins)]);
  }

  connect(url: string): void {
    const origin = this.resolveAllowedOrigin(url);
    this.connectionLog.push(origin);
  }

  assertConnectable(url: string): void {
    this.resolveAllowedOrigin(url);
  }

  get allowlist(): readonly string[] {
    return this.allowedOrigins;
  }

  get connections(): readonly string[] {
    return Object.freeze([...this.connectionLog]);
  }

  get connectionCount(): number {
    return this.connectionLog.length;
  }

  connectionsSince(index: number): readonly string[] {
    if (
      typeof index !== 'number' ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index > this.connectionLog.length
    ) {
      throw new Error(
        'prototype connection history index must be a non-negative safe integer within the current connection history',
      );
    }
    return Object.freeze(this.connectionLog.slice(index));
  }

  private resolveAllowedOrigin(url: unknown): string {
    const validatedUrl = validatePrototypeUrlString(url, 'prototype connection URL');
    let parsed: URL;
    try {
      parsed = new URL(validatedUrl);
    } catch {
      throw new Error(`Invalid prototype connection URL: ${validatedUrl}`);
    }
    const origin = parsed.origin;
    if (!this.allowedOrigins.includes(origin)) {
      throw new Error(`Connection outside prototype allowlist: ${origin}`);
    }
    return origin;
  }
}

export class SimulatedPrototypeWorker {
  private readonly cachedSegments = new Set<number>();
  private shouldFailFirstRun: boolean;

  readonly id: WorkerId;
  readonly segmentIndex: 0 | 1;
  readonly metadata: PrototypeWorkerMetadata;

  constructor(options: PrototypeWorkerOptions) {
    assertPrototypeWorkerOptionsContainer(options);
    const id = workerId(options.id);
    const segmentIndex = validatePrototypeSegmentIndex(options.segmentIndex);
    const webgpuAdapter = validatePrototypeNonEmptyString(
      options.webgpuAdapter,
      'prototype worker webgpuAdapter',
    );
    const vramMB = validatePrototypePositiveFiniteNumber(
      options.vramMB,
      'prototype worker vramMB',
    );
    if (options.failFirstRun !== undefined && typeof options.failFirstRun !== 'boolean') {
      throw new Error('prototype worker failFirstRun must be a boolean when provided');
    }

    this.id = id;
    this.segmentIndex = segmentIndex;
    Object.defineProperty(this, 'id', { writable: false, configurable: false });
    Object.defineProperty(this, 'segmentIndex', { writable: false, configurable: false });
    this.shouldFailFirstRun = options.failFirstRun ?? false;
    this.metadata = Object.freeze({
      webgpuAdapter,
      tier: WorkerTier.TIER_2,
      vramMB,
      cachedSegments: Object.freeze([] as number[]),
    });
  }

  async execute(input: SegmentExecutionInput): Promise<SegmentExecutionOutput> {
    const validatedInput = validateSegmentExecutionInput(input, this.segmentIndex);

    validatedInput.transport.connect(validatedInput.coordinatorUrl);
    validatedInput.transport.connect(
      `${validatedInput.cdnUrl}/models/proto-2b-q4/seg-${this.segmentIndex}.bin`,
    );

    if (this.shouldFailFirstRun) {
      this.shouldFailFirstRun = false;
      throw new Error(`Simulated worker loss: ${this.id}`);
    }

    const cacheHit = this.cachedSegments.has(this.segmentIndex);
    this.cachedSegments.add(this.segmentIndex);
    const startedAt = Date.now();

    if (this.segmentIndex === 0) {
      const normalizedPrompt = normalizePrompt(validatedInput.prompt);
      const checkpoint = makePrototypeCheckpoint(validatedInput.requestId, 0, normalizedPrompt);
      return {
        checkpoint,
        latencyMs: Date.now() - startedAt,
        cacheHit,
        checkpointBytes: checkpoint.hiddenStates.byteLength,
      };
    }

    const hiddenStates = validatedInput.checkpointHiddenStates;
    if (!hiddenStates) {
      throw new Error('Segment 1 requires a relayed checkpoint');
    }

    validatedInput.transport.connect(
      `${validatedInput.coordinatorUrl}/checkpoint/${validatedInput.requestId}/0`,
    );
    const hiddenText = bytesToText(hiddenStates);
    return {
      text: finalizeText(hiddenText),
      latencyMs: Date.now() - startedAt,
      cacheHit,
      checkpointBytes: hiddenStates.byteLength,
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

  constructor(options?: TwoWorkerPrototypeRunnerDependencies) {
    const dependencies = validateTwoWorkerPrototypeRunnerDependencies(options);
    const transport = dependencies.transport ?? new AllowlistedPrototypeTransport([
      DEFAULT_COORDINATOR_URL,
      DEFAULT_CDN_URL,
    ]);
    const segment0 = dependencies.segment0 ?? new SimulatedPrototypeWorker({
      id: 'proto-worker-seg0',
      segmentIndex: 0,
      webgpuAdapter: 'mock-webgpu-adapter-a',
      vramMB: 4096,
    });
    const segment1Primary = dependencies.segment1Primary ?? new SimulatedPrototypeWorker({
      id: 'proto-worker-seg1-primary',
      segmentIndex: 1,
      webgpuAdapter: 'mock-webgpu-adapter-b',
      vramMB: 4096,
      failFirstRun: true,
    });
    const segment1Standby = dependencies.segment1Standby ?? new SimulatedPrototypeWorker({
      id: 'proto-worker-seg1-standby',
      segmentIndex: 1,
      webgpuAdapter: 'mock-webgpu-adapter-c',
      vramMB: 4096,
    });

    assertPrototypeRunnerWorkerRole(segment0, 0, 'segment0');
    assertPrototypeRunnerWorkerRole(segment1Primary, 1, 'segment1Primary');
    assertPrototypeRunnerWorkerRole(segment1Standby, 1, 'segment1Standby');

    this.transport = transport;
    this.segment0 = segment0;
    this.segment1Primary = segment1Primary;
    this.segment1Standby = segment1Standby;
  }

  async run(options: TwoWorkerPrototypeOptions): Promise<PrototypeRunReport> {
    assertTwoWorkerPrototypeOptionsContainer(options);
    const prompt = validatePrototypePrompt(options.prompt);
    const coordinatorUrl = options.coordinatorUrl === undefined
      ? DEFAULT_COORDINATOR_URL
      : validatePrototypeNetworkUrl(options.coordinatorUrl, 'prototype coordinatorUrl');
    const cdnUrl = options.cdnUrl === undefined
      ? DEFAULT_CDN_URL
      : validatePrototypeNetworkUrl(options.cdnUrl, 'prototype cdnUrl');

    this.transport.assertConnectable(coordinatorUrl);
    this.transport.assertConnectable(cdnUrl);

    const startedAt = Date.now();
    const transportStartIndex = this.transport.connectionCount;
    const requestId = `proto-${++this.requestCounter}`;
    const referenceText = runReferencePath(prompt);
    const segments: PrototypeSegmentReport[] = [];

    const segment0Result = await this.segment0.execute({
      requestId,
      prompt,
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
      prompt,
      checkpoint: segment0Result.checkpoint,
      coordinatorUrl,
      cdnUrl,
      transport: this.transport,
    });
    segments.push(segment1Result.report);

    const splitText = segment1Result.output.text ?? '';
    return {
      requestId,
      prompt,
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

function assertPrototypeWorkerOptionsContainer(
  options: unknown,
): asserts options is PrototypeWorkerOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('prototype worker options must be a non-null object');
  }
}

function validateSegmentExecutionInput(
  input: unknown,
  segmentIndex: 0 | 1,
): ValidatedSegmentExecutionInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('prototype worker execution input must be a non-null object');
  }

  const candidate = input as Record<string, unknown>;
  const requestId = inferenceRequestId(candidate.requestId as string);
  const prompt = validatePrototypePrompt(candidate.prompt);
  const coordinatorUrl = validatePrototypeNetworkUrl(
    candidate.coordinatorUrl,
    'prototype worker coordinatorUrl',
  );
  const cdnUrl = validatePrototypeNetworkUrl(candidate.cdnUrl, 'prototype worker cdnUrl');
  if (!(candidate.transport instanceof AllowlistedPrototypeTransport)) {
    throw new Error('prototype worker transport must be an AllowlistedPrototypeTransport');
  }

  let checkpointHiddenStates: Uint8Array | undefined;
  if (segmentIndex === 1) {
    const checkpoint = candidate.checkpoint;
    if (typeof checkpoint !== 'object' || checkpoint === null || Array.isArray(checkpoint)) {
      throw new Error('prototype segment 1 requires a checkpoint object');
    }
    const hiddenStates = (checkpoint as Record<string, unknown>).hiddenStates;
    if (!(hiddenStates instanceof Uint8Array)) {
      throw new Error('prototype segment 1 checkpoint hiddenStates must be a Uint8Array');
    }
    checkpointHiddenStates = hiddenStates;
  }

  return {
    requestId,
    prompt,
    checkpointHiddenStates,
    coordinatorUrl,
    cdnUrl,
    transport: candidate.transport,
  };
}

function validateTwoWorkerPrototypeRunnerDependencies(
  options: unknown,
): TwoWorkerPrototypeRunnerDependencies {
  if (options === undefined) {
    return {};
  }
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('two-worker prototype runner options must be a non-null object when provided');
  }

  const dependencies = options as Record<string, unknown>;
  if (
    dependencies.transport !== undefined &&
    !(dependencies.transport instanceof AllowlistedPrototypeTransport)
  ) {
    throw new Error('two-worker prototype runner transport must be an AllowlistedPrototypeTransport');
  }
  for (const field of ['segment0', 'segment1Primary', 'segment1Standby'] as const) {
    const worker = dependencies[field];
    if (worker !== undefined && !(worker instanceof SimulatedPrototypeWorker)) {
      throw new Error(`two-worker prototype runner ${field} must be a SimulatedPrototypeWorker`);
    }
  }

  return options as TwoWorkerPrototypeRunnerDependencies;
}

function assertPrototypeRunnerWorkerRole(
  worker: SimulatedPrototypeWorker,
  expectedSegmentIndex: 0 | 1,
  role: 'segment0' | 'segment1Primary' | 'segment1Standby',
): void {
  if (worker.segmentIndex !== expectedSegmentIndex) {
    throw new Error(
      `two-worker prototype runner ${role} must target segment ${expectedSegmentIndex}`,
    );
  }
}

function assertTwoWorkerPrototypeOptionsContainer(
  options: unknown,
): asserts options is TwoWorkerPrototypeOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('two-worker prototype run options must be a non-null object');
  }
}

function validatePrototypePrompt(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('two-worker prototype prompt must be a string');
  }
  return value;
}

function validatePrototypeNetworkUrl(value: unknown, label: string): string {
  const validatedValue = validatePrototypeUrlString(value, label);
  let parsed: URL;
  try {
    parsed = new URL(validatedValue);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }
  if (parsed.origin === 'null') {
    throw new Error(`${label} must have a network origin`);
  }
  return validatedValue;
}

function validatePrototypeSegmentIndex(value: unknown): 0 | 1 {
  if (value !== 0 && value !== 1) {
    throw new Error('prototype worker segmentIndex must be 0 or 1');
  }
  return value;
}

function validatePrototypeNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function validatePrototypePositiveFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return value;
}

function validatePrototypeUrlString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
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
