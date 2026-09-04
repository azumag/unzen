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

## Result binding

Browser B must load the same manifest and must submit the identifiers from the checkpoint it actually consumed:

- `manifestDigest`
- `checkpointId`
- `checkpointDigest`
- `checkpointSourceWorkerGeneration`
- the exact `inputTokenIds`
- the observed `boundaryBytes`

The Coordinator compares all of them with the stored checkpoint before accepting the result. A manifest, checkpoint ID/digest, producer generation, token input, or boundary-size mismatch is rejected with HTTP 409. Profile isolation and Coordinator-only relay checks remain independent mandatory gates.

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
