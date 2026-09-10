# Multi-segment artifact stable snapshot verification

Issue #167 uses `tools/verify_multi_segment_artifacts.py` as the cheap host-side
integrity gate before numerical or browser execution. That verifier proves the
manifest semantics, measured artifact bytes/SHA-256 values, and browser-budget
ledger. When evidence is collected later or copied between machines, an
operator may also want to prove that the verifier observed one stable filesystem
snapshot rather than a path that was replaced while verification was running.

Use the stable snapshot wrapper for that stronger audit:

```bash
python tools/verify_multi_segment_artifact_snapshot.py \
  --manifest /absolute/path/to/llama-1b-budget-split/split-manifest.json \
  > /absolute/path/to/llama-1b-budget-split/artifact-snapshot-verification.json
```

The wrapper is stdlib-only and does not create an ONNX Runtime session. It first
reads the manifest as a bounded, non-symlink regular file, records its SHA-256
and filesystem identity, and resolves every declared segment graph and
external-data path. Each artifact is then stream-hashed through a descriptor
opened with `O_NOFOLLOW` / `O_CLOEXEC` where the platform exposes them. The
wrapper checks `(device, inode, size, mtime, ctime)` at the path, after open,
after hashing, and again at the path after hashing.

After the initial snapshot is fixed, the wrapper runs the existing
`verify_artifact_integrity()` gate. It then reads the manifest again and
re-measures every artifact. Verification fails if any of the following occurs:

- the manifest or an artifact is a final symlink or non-regular file;
- a declared relative path is absolute, parent-relative, or resolves through a
  parent outside the manifest directory;
- the manifest parsed by the wrapper does not have the same SHA-256 as the
  manifest measured by the existing integrity verifier;
- the manifest changes identity or digest while the existing verifier runs;
- any graph or external-data file changes filesystem identity, byte length, or
  SHA-256 while the existing verifier runs;
- the existing integrity verifier rejects the artifact set for its normal
  digest, byte-accounting, tier, or budget checks.

A same-content replacement is intentionally rejected. Even when a replacement
has identical bytes and therefore the same SHA-256, a different inode means the
verification crossed filesystem object instances and is not a single stable
snapshot.

The output embeds the normal artifact-integrity report and adds the manifest
SHA-256 plus a compact list of the graph/external-data files observed by the
stable audit. Keep this report next to the cached-decode or browser evidence
when the exact local artifact snapshot matters.

## Evidence boundary

This remains `diagnostic-only` host-side integrity evidence. It is not a
signature or provenance authority: a party able to replace the entire artifact
set and manifest consistently can still construct a different internally valid
bundle. It also does not prove WebGPU execution, GPU device-memory behavior,
distinct browser workers, Coordinator relay/resume behavior, or select a
production physical layout.
