# Real two-browser split run integrity

The local WebGPU split harness treats each `run` query parameter as an immutable execution namespace.

## Why

A Browser B result is evidence for one exact Browser A checkpoint. Reusing a run ID for another prompt, model manifest, Browser A generation, or boundary tensor set would make the stored result ambiguous. The Coordinator therefore binds the first accepted checkpoint for a run and rejects later conflicting writes instead of replacing it.

## Checkpoint binding

Browser A computes SHA-256 over the exact `split-manifest.json` bytes it loaded and sends that `manifestDigest` with the token IDs and boundary tensors. The Coordinator validates the tensor envelope and registered Browser A identity, then issues:

- `checkpointId`
- `checkpointDigest`
- `sourceWorkerGeneration`
- `manifestDigest`

`checkpointDigest` covers the manifest digest, input token IDs, source worker identity/generation/profile probe, and the two serialized boundary tensors. An exact checkpoint retry is idempotent and returns the existing binding. A different checkpoint under the same run ID returns `409 run-checkpoint-conflict`.

Browser A only declares the segment complete after the bounded checkpoint-relay receipt has also passed its semantic success contract: `ok=true`, boolean idempotency, Coordinator-owned relay, a valid run ID, lowercase 64-hex manifest/checkpoint digests, a bounded checkpoint ID, positive source-worker generation, confirmed profile isolation, and a positive tensor-byte count. The existing exact manifest-digest comparison then binds that validated receipt back to the manifest loaded by Browser A.

Before Browser B reconstructs any relayed tensor or creates the continuation inference session, it revalidates the immutable checkpoint metadata returned by the Coordinator. The checkpoint ID must be a non-empty string no longer than 128 characters, the checkpoint digest must be lowercase 64-hex SHA-256, and `sourceWorkerId` must satisfy the Coordinator worker-ID contract (`[A-Za-z0-9._-]`, 1–128 characters). `sourceWorkerIdentity.workerId` must exactly equal `sourceWorkerId`, and its generation must be a positive safe integer. This consumer-side preflight complements the existing exact manifest digest, token-ID, and tensor-wire checks so a malformed relay response fails before tensor allocation or continuation inference.

## Result binding

Browser B must load the same manifest and must submit the identifiers from the checkpoint it actually consumed:

- `manifestDigest`
- `checkpointId`
- `checkpointDigest`
- `checkpointSourceWorkerGeneration`
- the exact `inputTokenIds`
- the observed `boundaryBytes`

The Coordinator compares all of them with the stored checkpoint before accepting the result. A manifest, checkpoint ID/digest, producer generation, token input, or boundary-size mismatch is rejected with HTTP 409. Profile isolation and Coordinator-only relay checks remain independent mandatory gates.

Browser B only declares split inference complete after the bounded result-acceptance receipt passes its semantic success contract. It requires a successful Coordinator write with boolean idempotency, a valid run ID, lowercase SHA-256 result/checkpoint digests, a bounded checkpoint ID, and the Coordinator-issued profile-isolation evidence. That evidence must identify valid source/segment-1 workers and positive generations and must carry distinct lowercase SHA-256 probe hashes from the Coordinator-issued HttpOnly-cookie proof. The runner then keeps its exact checkpoint ID/digest equality check against the checkpoint actually consumed before logging the result digest.

The first accepted result receives a `resultDigest`. An exact retry by the same Browser B generation is idempotent. A primary/standby race or any other different result for an already completed run returns `409 run-result-conflict`; the original result remains unchanged.

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

The IDs and digests prevent mixed-run evidence inside the local Coordinator. They do not promote self-reported browser measurements to `captured-and-verified` or production evidence by themselves; the evidence-level rules in the P0 handoff still apply.
