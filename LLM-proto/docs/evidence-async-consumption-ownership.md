# Async evidence consumption ownership

## Contract

`validateEvidenceEnvelope()` keeps its existing compatibility contract: a successful result returns the caller-provided `envelope` object. That object is not an immutable trust artifact and may reflect caller mutation after or during an asynchronous validation operation.

Trust-sensitive code that consumes envelope fields after `await` must instead use `validateEvidenceEnvelopeForConsumption()`. The consumption wrapper captures one validator-owned generation with platform `structuredClone()` before artifact loading or independent verification can run. When validation succeeds, the returned `validation.envelope` is that owned generation rather than the caller object.

This means payload fields, artifact metadata such as `artifact.sha256`, provenance fields, and other envelope data consumed by the gate are all bound to the same pre-callback generation. A caller-supplied `loadArtifact()` or `verifyArtifact()` callback may mutate the original envelope, but those mutations cannot change what the downstream gate reads from the successful consumption result.

## Payload policy

Async trust-sensitive evidence is treated as data rather than as an identity-bearing object graph. The owned generation therefore uses structured-clone semantics:

- plain objects, arrays, strings, numbers, booleans, `Date`, `ArrayBuffer`, typed arrays, cycles, and other structured-clone-supported values are copied into the owned generation;
- caller object identity, custom user-class prototype identity, accessors, and other non-data behavior are not part of the trust contract;
- a base-valid envelope that cannot be structured-cloned fails closed in the consumption wrapper with the existing `invalid-envelope` issue taxonomy at `$.payload`;
- the base `validateEvidenceEnvelope()` API is unchanged for callers that intentionally depend on its legacy caller-owned identity.

The wrapper does not eagerly execute `loadArtifact()` or `verifyArtifact()`. Those callbacks remain controlled by the existing validator and retain its lazy execution order and validation taxonomy.

## Downstream rule

After asynchronous validation, readiness/security gates must not reread the original caller envelope. They should consume the envelope returned by `validateEvidenceEnvelopeForConsumption()` (or an equivalent operation-owned snapshot established before the async boundary).

The signed-runner browser-preview gate is the representative migrated consumer for this contract. Regression coverage mutates the original payload and artifact digest from both `loadArtifact()` and `verifyArtifact()` and verifies that the gate/result continue to consume the original validated generation.

## Evidence boundary

This change is ownership/TOCTOU hardening only. It is not new real-model, physical WebGPU, distinct-browser relay/latency, worker-loss/resume, or residency evidence for #167.
