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

Regular files are opened with no-follow semantics where the host provides them and are re-statted through the open file descriptor. The descriptor's device/inode identity must match the non-symlink regular file observed by the pre-open `lstat()`, so a regular-file pathname rebind before `open()` fails before any bytes are consumed. Large payload files are hashed through a bounded 1 MiB buffer rather than being loaded into memory as one `Buffer`.

## Browser diagnostic consumption

When `browser-harness/endpoint-embedding-eight-physical-webgpu/serve.mjs` consumes the generated `PREFLIGHT_REPORT`, it does not perform a path check and then reopen the pathname for the JSON read. The exact report path is opened through the shared descriptor-bound regular-file helper: a pre-open `lstat()` must identify a non-symlink regular file, `O_NOFOLLOW` is used where available, and the opened descriptor must match the pre-open device/inode identity. The JSON bytes are then read from that accepted `FileHandle`, the descriptor is re-statted to catch size drift during the read, and the handle is closed on every path before the validated report is retained by the server.

This closes the report-path check/read TOCTOU gap without changing the report schema or introducing a new report-size policy. A separate bounded-report policy would be a distinct compatibility/resource decision; this hardening only binds the bytes parsed by the diagnostic server to the file object that passed startup validation.

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
