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

The JSON reader used for the generated manifest and reused preflight snapshots keeps that same descriptor/open-identity contract but no longer calls `FileHandle.readFile()` without a bound. It reads incrementally under the repository's 16 MiB stable-text ceiling, probes one byte beyond the ceiling before accepting an exactly-full read, then requires the descriptor's device/inode, size, `mtime`, and `ctime` to match the accepted pre-read snapshot before parsing. `atime` is intentionally excluded because the read itself may update it. The pathname is then `lstat()`ed again and must still name a non-symlink regular file with the same device/inode as the accepted descriptor; disappearance or replacement during the read fails closed. The accepted bytes are decoded with fatal UTF-8 semantics, so malformed byte sequences fail closed instead of being normalized to replacement characters. The byte ceiling is validated before filesystem access and can be lowered only for focused tests; normal callers use the fixed 16 MiB default.

This JSON snapshot check catches deterministic pathname replacement and observable same-size in-place rewrites while preserving the accepted descriptor as the byte source. It is not an adversarial filesystem snapshot primitive: a filesystem that changes content without exposing any device/inode/size/mtime/ctime change can still evade the metadata guard.

## Browser diagnostic consumption

When `browser-harness/endpoint-embedding-eight-physical-webgpu/serve.mjs` consumes the generated `PREFLIGHT_REPORT`, it does not perform a path check and then reopen the pathname for the JSON read. The exact report path is opened through the shared descriptor-bound regular-file helper: a pre-open `lstat()` must identify a non-symlink regular file, `O_NOFOLLOW` is used where available, and the opened descriptor must match the pre-open device/inode identity. The JSON bytes are then read from that accepted `FileHandle` under the 16 MiB report ceiling. After the exact accepted byte count is read and a one-byte growth probe confirms EOF, the same descriptor is re-statted and its device/inode, size, `mtime`, and `ctime` must still match the accepted snapshot. Growth, shrink, or an observable same-size in-place rewrite therefore fails closed before JSON parsing. `atime` is intentionally excluded because the read itself may update it. The stable byte sequence is then decoded with fatal UTF-8 validation, so malformed byte sequences are rejected rather than normalized to U+FFFD before `JSON.parse()`. The decoder preserves the prior behavior for an initial BOM by retaining it as a literal code point. The handle is closed on every path before the validated report is retained by the server.

This closes the report-path check/read TOCTOU gap, detects observable generation drift on the accepted file object, and requires a faithful UTF-8 decode without changing the report schema or evidence level. It is still not a filesystem snapshot primitive: a filesystem that can change content without exposing any size/mtime/ctime change can evade the metadata guard.

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
