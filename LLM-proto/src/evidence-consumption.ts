import {
  validateEvidenceEnvelope,
  type EvidenceEnvelope,
  type EvidenceValidationIssue,
  type EvidenceValidationOptions,
  type EvidenceValidationResult,
} from './evidence.js';

const SNAPSHOT_FAILURE_MESSAGE =
  'validated evidence must be structured-cloneable for async trust-sensitive consumption';

/**
 * Validate evidence while preserving an operation-owned envelope generation for
 * post-await trust decisions.
 *
 * `validateEvidenceEnvelope()` intentionally preserves the caller-owned envelope
 * identity for compatibility. Trust-sensitive consumers must not reread that
 * object after async artifact loading/verifier callbacks, because caller code
 * can mutate it while validation is suspended. This wrapper snapshots the input
 * before validation starts and, on success, returns that owned generation as the
 * result envelope instead.
 *
 * Structured-clone semantics are deliberate: evidence consumed by async gates is
 * data, not an identity-bearing object graph. Unsupported runtime values fail
 * closed with the existing `invalid-envelope` taxonomy. The underlying artifact
 * loader and independent verifier remain lazy and are invoked only by the base
 * validator when its normal captured-evidence preconditions are satisfied.
 */
export async function validateEvidenceEnvelopeForConsumption<TPayload = unknown>(
  input: unknown,
  options: EvidenceValidationOptions = {},
): Promise<EvidenceValidationResult<TPayload>> {
  let ownedEnvelope: EvidenceEnvelope<TPayload> | undefined;
  let snapshotIssue: EvidenceValidationIssue | undefined;

  try {
    if (typeof structuredClone !== 'function') {
      throw new TypeError('structuredClone is unavailable');
    }
    ownedEnvelope = structuredClone(input) as EvidenceEnvelope<TPayload>;
  } catch {
    snapshotIssue = {
      code: 'invalid-envelope',
      path: '$.payload',
      message: SNAPSHOT_FAILURE_MESSAGE,
    };
  }

  const validation = await validateEvidenceEnvelope<TPayload>(input, options);
  if (validation.status !== 'valid') return validation;

  if (snapshotIssue !== undefined || ownedEnvelope === undefined) {
    return {
      status: 'invalid',
      claimedEvidenceLevel: validation.claimedEvidenceLevel,
      claimedReadinessStatus: validation.claimedReadinessStatus,
      issues: [...validation.issues, snapshotIssue ?? {
        code: 'invalid-envelope',
        path: '$.payload',
        message: SNAPSHOT_FAILURE_MESSAGE,
      }],
    };
  }

  return {
    ...validation,
    envelope: ownedEnvelope,
  };
}
