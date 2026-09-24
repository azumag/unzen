# Real two-browser split run integrity

The local WebGPU split harness treats each `run` query parameter as an immutable execution namespace.

## Why

A Browser B result is evidence for one exact Browser A checkpoint. Reusing a run ID for another prompt, model manifest, Browser A generation, boundary tensor set, or accepted execution timing would make the stored result ambiguous. The Coordinator therefore binds the first accepted checkpoint for a run and rejects later conflicting writes instead of replacing it.

## Checkpoint binding

Browser A computes SHA-256 over the exact `split-manifest.json` bytes it loaded and sends that `manifestDigest` with the token IDs, boundary tensors, and inference-only `segmentExecutionMs`. The Coordinator validates the tensor envelope, registered Browser A identity, and execution timing, then issues:

- `checkpointId`
- `checkpointDigest`
- `sourceWorkerGeneration`
- `manifestDigest`

`segmentExecutionMs` is required to be a finite, non-negative JSON number. It is the existing browser measurement around `InferenceSession.run()` only; artifact loading, cache lookup, and session creation remain separate measurements and are not folded into this value.

`checkpointDigest` covers the manifest digest, input token IDs, accepted `segmentExecutionMs`, source worker identity/generation/profile probe, and the two serialized boundary tensors. An exact checkpoint retry is idempotent and returns the existing binding. A retry that changes the execution timing or any other bound field returns `409 run-checkpoint-conflict`.

Browser A only declares the segment complete after the bounded checkpoint-relay receipt has also passed its semantic success contract: `ok=true`, boolean idempotency, Coordinator-owned relay, a valid run ID, lowercase 64-hex manifest/checkpoint digests, a bounded checkpoint ID, positive source-worker generation, confirmed profile isolation, and a positive tensor-byte count. The existing exact manifest-digest comparison then binds that validated receipt back to the manifest loaded by Browser A.

Before Browser B reconstructs any relayed tensor or creates the continuation inference session, it revalidates the immutable checkpoint metadata returned by the Coordinator. The checkpoint ID must be a non-empty string no longer than 128 characters, the checkpoint digest must be lowercase 64-hex SHA-256, and `sourceWorkerId` must satisfy the Coordinator worker-ID contract (`[A-Za-z0-9._-]`, 1–128 characters). `sourceWorkerIdentity.workerId` must exactly equal `sourceWorkerId`, and its generation must be a positive safe integer. This consumer-side preflight complements the existing exact manifest digest, token-ID, and tensor-wire checks so a malformed relay response fails before tensor allocation or continuation inference.

## Result binding

Browser B must load the same manifest and must submit the identifiers and timing from the checkpoint it actually consumed:

- `manifestDigest`
- `checkpointId`
- `checkpointDigest`
- `checkpointSourceWorkerGeneration`
- the exact `inputTokenIds`
- the observed `boundaryBytes`
- `segment0ExecutionMs`, copied exactly from the accepted checkpoint
- its own inference-only `segment1ExecutionMs`

Both execution timing fields must be finite, non-negative JSON numbers. The Coordinator compares `segment0ExecutionMs` exactly with the stored checkpoint timing before accepting the result, in addition to the manifest, checkpoint ID/digest, producer generation, token input, and boundary-size bindings. A mismatch is rejected with HTTP 409. Malformed timing is rejected with HTTP 400 before result state is created. Profile isolation and Coordinator-only relay checks remain independent mandatory gates.

Browser B only declares split inference complete after the bounded result-acceptance receipt passes its semantic success contract. It requires a successful Coordinator write with boolean idempotency, a valid run ID, lowercase SHA-256 result/checkpoint digests, a bounded checkpoint ID, and the Coordinator-issued profile-isolation evidence. That evidence must identify valid source/segment-1 workers and positive generations and must carry distinct lowercase SHA-256 probe hashes from the Coordinator-issued HttpOnly-cookie proof. The runner then keeps its exact checkpoint ID/digest equality check against the checkpoint actually consumed before logging the result digest.

The first accepted result receives a `resultDigest`. The digest includes both accepted segment execution timings, so an exact retry by the same Browser B generation is idempotent while changing either timing changes the immutable result identity. A primary/standby race or any other different result for an already completed run returns `409 run-result-conflict`; the original result remains unchanged.

This timing contract is intentionally mandatory for the local real two-browser harness. Its browser runner already emits all three fields (`segmentExecutionMs`, `segment0ExecutionMs`, and `segment1ExecutionMs`), and the Coordinator API is not treated as a versioned compatibility surface for timing-less synthetic clients. Tests and ad-hoc clients must provide real captured values rather than invented fallback timings.

## Run-ID reuse rule

Use a fresh run ID for every new execution, including:

- a different prompt or token input;
- a regenerated or edited split manifest;
- a fresh cold/warm timing run;
- retrying inference after Browser A actually reruns the segment;
- a new experiment after a completed run.

Only HTTP-level retries of the same already-produced checkpoint/result should reuse a run ID. Standby Browser B may reuse the run ID because it consumes the already-bound Browser A checkpoint; once either primary or standby commits the result, the run is terminal and immutable.

Examples:

```text
smollm2-real-cold-001
smollm2-real-warm-001
smollm2-resume-001
```

Do not reset a run by overwriting `/checkpoint` or `/result`. Start another run ID instead.

## Evidence interpretation

The IDs, digests, and timing bindings prevent mixed-run evidence inside the local Coordinator. They do not make browser timing externally verified, and they do not promote self-reported browser measurements to `captured-and-verified` or production evidence by themselves; the evidence-level rules in the P0 handoff still apply.
