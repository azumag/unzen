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
const MAX_PROTOTYPE_ALLOWLIST_ENTRIES = 1024;
const NativeUint8Array = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(NativeUint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;

export class AllowlistedPrototypeTransport {
  private readonly connectionLog: string[] = [];
  private readonly allowedOrigins: readonly string[];

  constructor(allowedOrigins: readonly string[]) {
    if (!isPrototypeArray(allowedOrigins)) {
      throw new Error('prototype allowedOrigins must be an array');
    }

    const length = readPrototypeArrayLength(
      allowedOrigins,
      'prototype allowedOrigins',
      MAX_PROTOTYPE_ALLOWLIST_ENTRIES,
    );
    const canonicalOrigins: string[] = [];
    for (let index = 0; index < length; index++) {
      const value = readPrototypeProperty(
        allowedOrigins as unknown as object,
        index,
        `prototype allowlist URL at index ${index}`,
      );
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
      canonicalOrigins.push(parsed.origin);
    }
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
    const optionsObject = options as unknown as object;
    const id = workerId(readPrototypeProperty(optionsObject, 'id', 'prototype worker id') as string);
    const segmentIndex = validatePrototypeSegmentIndex(
      readPrototypeProperty(optionsObject, 'segmentIndex', 'prototype worker segmentIndex'),
    );
    const webgpuAdapter = validatePrototypeNonEmptyString(
      readPrototypeProperty(optionsObject, 'webgpuAdapter', 'prototype worker webgpuAdapter'),
      'prototype worker webgpuAdapter',
    );
    const vramMB = validatePrototypePositiveFiniteNumber(
      readPrototypeProperty(optionsObject, 'vramMB', 'prototype worker vramMB'),
      'prototype worker vramMB',
    );
    const failFirstRun = readPrototypeProperty(
      optionsObject,
      'failFirstRun',
      'prototype worker failFirstRun',
    );
    if (failFirstRun !== undefined && typeof failFirstRun !== 'boolean') {
      throw new Error('prototype worker failFirstRun must be a boolean when provided');
    }

    this.id = id;
    this.segmentIndex = segmentIndex;
    Object.defineProperty(this, 'id', { writable: false, configurable: false });
    Object.defineProperty(this, 'segmentIndex', { writable: false, configurable: false });
    this.shouldFailFirstRun = failFirstRun ?? false;
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
    const optionsObject = options as unknown as object;
    const prompt = validatePrototypePrompt(
      readPrototypeProperty(optionsObject, 'prompt', 'two-worker prototype prompt'),
    );
    const coordinatorUrlInput = readPrototypeProperty(
      optionsObject,
      'coordinatorUrl',
      'prototype coordinatorUrl',
    );
    const coordinatorUrl = coordinatorUrlInput === undefined
      ? DEFAULT_COORDINATOR_URL
      : validatePrototypeNetworkUrl(coordinatorUrlInput, 'prototype coordinatorUrl');
    const cdnUrlInput = readPrototypeProperty(optionsObject, 'cdnUrl', 'prototype cdnUrl');
    const cdnUrl = cdnUrlInput === undefined
      ? DEFAULT_CDN_URL
      : validatePrototypeNetworkUrl(cdnUrlInput, 'prototype cdnUrl');

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

function isPrototypeArray(value: unknown): boolean {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function isPrototypeInstanceOf(value: unknown, constructor: Function): boolean {
  try {
    return value instanceof (constructor as new (...args: never[]) => object);
  } catch {
    return false;
  }
}

function readPrototypeProperty(
  container: object,
  key: PropertyKey,
  label: string,
): unknown {
  try {
    return (container as Record<PropertyKey, unknown>)[key];
  } catch {
    throw new Error(`${label} could not be read`);
  }
}

function readPrototypeArrayLength(
  value: readonly unknown[],
  label: string,
  maxLength: number,
): number {
  const length = readPrototypeProperty(value as unknown as object, 'length', `${label} length`);
  if (
    typeof length !== 'number'
    || !Number.isSafeInteger(length)
    || length < 0
    || length > maxLength
  ) {
    throw new Error(`${label} length must be a safe integer between 0 and ${maxLength}`);
  }
  return length;
}

function assertPrototypeWorkerOptionsContainer(
  options: unknown,
): asserts options is PrototypeWorkerOptions {
  if (typeof options !== 'object' || options === null || isPrototypeArray(options)) {
    throw new Error('prototype worker options must be a non-null object');
  }
}

function validateSegmentExecutionInput(
  input: unknown,
  segmentIndex: 0 | 1,
): ValidatedSegmentExecutionInput {
  if (typeof input !== 'object' || input === null || isPrototypeArray(input)) {
    throw new Error('prototype worker execution input must be a non-null object');
  }

  const inputObject = input as object;
  const requestId = inferenceRequestId(
    readPrototypeProperty(inputObject, 'requestId', 'prototype worker requestId') as string,
  );
  const prompt = validatePrototypePrompt(
    readPrototypeProperty(inputObject, 'prompt', 'prototype worker prompt'),
  );
  const coordinatorUrl = validatePrototypeNetworkUrl(
    readPrototypeProperty(inputObject, 'coordinatorUrl', 'prototype worker coordinatorUrl'),
    'prototype worker coordinatorUrl',
  );
  const cdnUrl = validatePrototypeNetworkUrl(
    readPrototypeProperty(inputObject, 'cdnUrl', 'prototype worker cdnUrl'),
    'prototype worker cdnUrl',
  );
  const transport = readPrototypeProperty(inputObject, 'transport', 'prototype worker transport');
  if (!isPrototypeInstanceOf(transport, AllowlistedPrototypeTransport)) {
    throw new Error('prototype worker transport must be an AllowlistedPrototypeTransport');
  }

  let checkpointHiddenStates: Uint8Array | undefined;
  if (segmentIndex === 1) {
    const checkpoint = readPrototypeProperty(inputObject, 'checkpoint', 'prototype segment 1 checkpoint');
    if (typeof checkpoint !== 'object' || checkpoint === null || isPrototypeArray(checkpoint)) {
      throw new Error('prototype segment 1 requires a checkpoint object');
    }
    const hiddenStates = snapshotPrototypeUint8Array(
      readPrototypeProperty(checkpoint, 'hiddenStates', 'prototype segment 1 checkpoint hiddenStates'),
    );
    if (!hiddenStates) {
      throw new Error('prototype segment 1 checkpoint hiddenStates must be a Uint8Array');
    }
    try {
      bytesToText(hiddenStates);
    } catch {
      throw new Error('prototype segment 1 checkpoint hiddenStates must be valid UTF-8');
    }
    checkpointHiddenStates = hiddenStates;
  }

  return {
    requestId,
    prompt,
    checkpointHiddenStates,
    coordinatorUrl,
    cdnUrl,
    transport: transport as AllowlistedPrototypeTransport,
  };
}

function snapshotPrototypeUint8Array(value: unknown): Uint8Array | undefined {
  let isUint8Array = false;
  try {
    isUint8Array = value instanceof NativeUint8Array;
  } catch {
    return undefined;
  }
  if (!isUint8Array || !ArrayBuffer.isView(value)) {
    return undefined;
  }
  if (
    typeof typedArrayBufferGetter !== 'function'
    || typeof typedArrayByteOffsetGetter !== 'function'
    || typeof typedArrayByteLengthGetter !== 'function'
  ) {
    return undefined;
  }

  try {
    const buffer = typedArrayBufferGetter.call(value) as ArrayBufferLike;
    const byteOffset = typedArrayByteOffsetGetter.call(value) as number;
    const byteLength = typedArrayByteLengthGetter.call(value) as number;
    const source = new NativeUint8Array(buffer, byteOffset, byteLength);
    const owned = new NativeUint8Array(byteLength);
    NativeUint8Array.prototype.set.call(owned, source);
    return owned;
  } catch {
    return undefined;
  }
}

function validateTwoWorkerPrototypeRunnerDependencies(
  options: unknown,
): TwoWorkerPrototypeRunnerDependencies {
  if (options === undefined) {
    return {};
  }
  if (typeof options !== 'object' || options === null || isPrototypeArray(options)) {
    throw new Error('two-worker prototype runner options must be a non-null object when provided');
  }

  const optionsObject = options as object;
  const transport = readPrototypeProperty(
    optionsObject,
    'transport',
    'two-worker prototype runner transport',
  );
  if (transport !== undefined && !isPrototypeInstanceOf(transport, AllowlistedPrototypeTransport)) {
    throw new Error('two-worker prototype runner transport must be an AllowlistedPrototypeTransport');
  }

  const segment0 = readPrototypeProperty(
    optionsObject,
    'segment0',
    'two-worker prototype runner segment0',
  );
  if (segment0 !== undefined && !isPrototypeInstanceOf(segment0, SimulatedPrototypeWorker)) {
    throw new Error('two-worker prototype runner segment0 must be a SimulatedPrototypeWorker');
  }

  const segment1Primary = readPrototypeProperty(
    optionsObject,
    'segment1Primary',
    'two-worker prototype runner segment1Primary',
  );
  if (
    segment1Primary !== undefined
    && !isPrototypeInstanceOf(segment1Primary, SimulatedPrototypeWorker)
  ) {
    throw new Error('two-worker prototype runner segment1Primary must be a SimulatedPrototypeWorker');
  }

  const segment1Standby = readPrototypeProperty(
    optionsObject,
    'segment1Standby',
    'two-worker prototype runner segment1Standby',
  );
  if (
    segment1Standby !== undefined
    && !isPrototypeInstanceOf(segment1Standby, SimulatedPrototypeWorker)
  ) {
    throw new Error('two-worker prototype runner segment1Standby must be a SimulatedPrototypeWorker');
  }

  return {
    transport: transport as AllowlistedPrototypeTransport | undefined,
    segment0: segment0 as SimulatedPrototypeWorker | undefined,
    segment1Primary: segment1Primary as SimulatedPrototypeWorker | undefined,
    segment1Standby: segment1Standby as SimulatedPrototypeWorker | undefined,
  };
}

function assertPrototypeRunnerWorkerRole(
  worker: SimulatedPrototypeWorker,
  expectedSegmentIndex: 0 | 1,
  role: 'segment0' | 'segment1Primary' | 'segment1Standby',
): void {
  const segmentIndex = readPrototypeProperty(
    worker as unknown as object,
    'segmentIndex',
    `two-worker prototype runner ${role} segmentIndex`,
  );
  if (segmentIndex !== expectedSegmentIndex) {
    throw new Error(
      `two-worker prototype runner ${role} must target segment ${expectedSegmentIndex}`,
    );
  }
}

function assertTwoWorkerPrototypeOptionsContainer(
  options: unknown,
): asserts options is TwoWorkerPrototypeOptions {
  if (typeof options !== 'object' || options === null || isPrototypeArray(options)) {
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
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
