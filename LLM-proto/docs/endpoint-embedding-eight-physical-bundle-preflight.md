# 8-physical endpoint embedding bundle preflight

Tracking: #167, #324. Runtime-plan contract: #322 / PR #323.

## Purpose

Before launching Chrome or creating an ORT WebGPU session, re-verify the **actual files on disk** that will be supplied to the diagnostic 8-physical embedding runtime plan.

This preflight is intentionally earlier than browser execution. It does not choose the 8-physical architecture and does not convert local integrity evidence into WebGPU runtime evidence.

## Run

First generate the real payload manifest and payload files with the #321 helper. Then provide the pinned zero-offset graph used by the existing embedding harness:

```bash
cd LLM-proto
npm run ops:preflight-endpoint-embedding-eight-physical -- \
  /tmp/unzen-endpoint-embedding-eight-physical/manifest.json \
  /path/to/embedding-offset-0.onnx \
  /tmp/unzen-endpoint-embedding-eight-physical
```

The command fails before any browser work when:

- the generated manifest drifts from the diagnostic #323 contract, is not a regular file, or is a symlink
- the manifest's `payloadSetSha256` no longer matches the Python generator's canonical serialization of its eight `physicalArtifacts`
- the reused graph is not exactly 260 bytes with SHA-256 `70a56611e458eb6af8333329424756275aa5ad6b08467fa51912532867b6ce50`
- the payload directory itself is missing, not a directory, or a symlink
- any of the eight payload files is missing, a symlink, not a regular file, has the wrong byte count, or hashes differently from the generated manifest
- the payload/tile geometry is no longer 1:1, contiguous, zero-offset, or diagnostic-only

Regular files are opened with no-follow semantics where the host provides them and are re-statted through the open file descriptor. Large payload files are hashed through a bounded 1 MiB buffer rather than being loaded into memory as one `Buffer`.

## Output

On success the command prints a machine-readable JSON report containing:

- `status=pass`
- `decisionStatus=diagnostic-only`
- `selectedPhysicalArtifactCount=null`
- pinned source graph / full external-data identity
- verified manifest payload-set digest
- actual graph file bytes / SHA-256
- actual bytes / SHA-256 for all eight payload files
- the eight-entry runtime plan from #323
- `evidenceBoundary=actual-file-integrity-preflight-only`

Keep this report with the subsequent browser capture evidence so the exact bytes supplied to the runtime can be traced.

## Evidence boundary

A green preflight only proves local file integrity against the generated diagnostic manifest and pinned graph identity. It is **not** proof that ORT Web accepted the range supply, WebGPU produced equivalent output, memory stayed within budget, or release/cancel reclaimed resources.

The next step is a real Chrome/ORT WebGPU capture using only a bundle that passes this preflight. #167's permanent segment/cache/runtime policy remains unchanged until the browser correctness, memory, timing, and reclamation evidence is captured.
