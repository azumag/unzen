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
external-data path. Each artifact is then stream-hashed through a descriptor.

On platforms that expose `dir_fd`, `O_DIRECTORY`, `O_NOFOLLOW`, and
`follow_symlinks=False` for the required filesystem calls, the manifest
directory is held open as an anchor for the whole verification. Every declared
relative artifact path is walked one parent component at a time from that
anchor. Each intermediate directory is checked without following symlinks,
opened with `O_DIRECTORY | O_NOFOLLOW`, and bound to its `(device, inode)`
identity before the final regular file is opened. The same parent chain is
re-opened after each read and again after the underlying integrity verifier, so
a same-content replacement of a parent directory fails even if the files inside
are hard links to the original file instances.

The report records this stronger mode as:

```json
{
  "pathResolutionMode": "component-anchored-dirfd"
}
```

On platforms where those primitives are unavailable, the wrapper preserves the
portable pre-#356 behavior and reports:

```json
{
  "pathResolutionMode": "final-component-only"
}
```

That fallback still rejects absolute/parent-relative paths, paths resolving
outside the manifest directory, final symlinks, non-regular files, and file
identity/digest drift. It does **not** claim protection against a race that swaps
an intermediate directory component while a pathname is being opened. Evidence
that depends on the stronger path-race property must therefore require
`component-anchored-dirfd` rather than silently treating the fallback as
equivalent.

After the initial snapshot is fixed, the wrapper runs the existing
`verify_artifact_integrity()` gate. It then reads the manifest again and
re-measures every artifact. Verification fails if any of the following occurs:

- the manifest or an artifact is a final symlink or non-regular file;
- a declared relative path is absolute, parent-relative, or resolves through a
  parent outside the manifest directory;
- in `component-anchored-dirfd` mode, an intermediate declared-path component
  is a symlink or ceases to resolve to the same directory instance;
- in `component-anchored-dirfd` mode, the anchored manifest-directory pathname
  ceases to resolve to the same directory instance while verification runs;
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
snapshot. In component-anchored mode the same rule applies to intermediate
artifact directories by `(device, inode)` identity.

The output embeds the normal artifact-integrity report and adds the manifest
SHA-256 plus a compact list of the graph/external-data files observed by the
stable audit. Keep this report next to the cached-decode or browser evidence
when the exact local artifact snapshot matters.

## Evidence boundary

This remains `diagnostic-only` host-side integrity evidence. It is not a
signature or provenance authority: a party able to replace the entire artifact
set and manifest consistently before verification can still construct a
different internally valid bundle. Component-anchored mode closes pathname
races for declared descendants while the manifest-directory descriptor remains
open, but it does not make the separate `verify_artifact_integrity()` call an
fd-only transaction; a sufficiently privileged actor performing a transient
swap-and-restore of the complete manifest-directory pathname during exactly
that call is outside this wrapper's guarantee. The wrapper detects a directory
replacement that is still present at its post-check.

It also does not prove WebGPU execution, GPU device-memory behavior, distinct
browser workers, Coordinator relay/resume behavior, or select a production
physical layout.
