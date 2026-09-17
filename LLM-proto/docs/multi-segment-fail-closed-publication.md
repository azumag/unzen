# Multi-segment fail-closed publication

`tools/prepare_budgeted_multi_split_atomic.py` is the safer publication entry point for repeated or expensive budgeted split preparation, including the real 1B workflow tracked by #167.

The existing `tools/multi_segment_onnx.py` generator is retained for compatibility and for callers that intentionally own the destination lifecycle themselves. The atomic wrapper changes where generation occurs, not the generated manifest schema or the browser artifact budget policy.

## Publication lifecycle

1. Create a private temporary staging directory inside the requested output directory. Keeping staging on the destination filesystem allows final `os.replace()` operations to stay same-filesystem.
2. Run `prepare_budgeted_multi_split()` entirely inside staging. Graph extraction, external-data repacking, ONNX runtime checks, measured byte accounting, browser budget enforcement, hashes, and the final staged `split-manifest.json` must all succeed before the published artifact set is touched.
3. Re-run the existing source-collision and destination-node preflights against the *final* output paths. If the previous valid publication used more segments than the staged replacement, include the removed tail `segmentN.onnx` / `segmentN.onnx_data` paths in those preflights as generator-owned mutation targets. This preserves the source overwrite, symlink, non-regular node, and multiple-hard-link protections before the old commit marker is invalidated.
4. Verify that every staged graph/external-data file named by the generated layout exists.
5. Remove the previously published `split-manifest.json` before replacing or deleting the first final artifact.
6. Move current graph and external-data files into place. If a current segment is fully embedded, remove a stale previous `segmentN.onnx_data` for that segment. If the new split has fewer segments than the previous valid generated layout, remove the old tail graph/data files as well. Unrelated files in the output directory are not part of this cleanup.
7. Move the new `split-manifest.json` into place last. The manifest acts as the publication commit marker.

## Failure semantics

This is **fail-closed multi-file publication**, not a globally atomic filesystem transaction.

- If generation or staging validation fails, previously published graph/data files and manifest remain untouched.
- Unsafe previous tail artifacts are rejected during preflight while the previous manifest is still present.
- If publication fails after the old manifest has been invalidated, the directory may contain a mixture of old and new graph/data files, but `split-manifest.json` remains absent. Consumers therefore cannot mistake an old manifest for a coherent mixed artifact set.
- A successful publication exposes the new manifest only after every current graph/data file has reached its final name and any generator-owned tail from a larger previous split has been removed.
- Temporary staging content is removed automatically on both success and failure.

Stale-tail discovery is intentionally conservative. Cleanup is derived only from a previous manifest that still satisfies the generator-owned segment layout contract. A malformed or legacy manifest is still replaceable, but it is not trusted to authorize deletion of additional output paths.

A process or machine crash can still occur between individual `os.replace()` / `unlink()` calls. Crash-durable directory fsync and a filesystem-wide atomic rename of a whole non-empty destination directory are outside this contract. Consumers must treat the presence of a validated `split-manifest.json` as the artifact-set commit marker and should continue to run the existing artifact-integrity preflight before numerical or browser execution.

This cleanup does not add reader snapshot isolation. A consumer that already loaded the previous manifest can still race with publication; the compatibility decision for versioned/content-addressed publication or an explicit consumer retry contract remains tracked separately in #908.

## CLI

The arguments mirror `multi_segment_onnx.py`:

```bash
python tools/prepare_budgeted_multi_split_atomic.py \
  /path/to/model_q4.onnx \
  /path/to/output \
  --target-bytes $((200 * 1024 * 1024)) \
  --preferred-max-bytes $((256 * 1024 * 1024))
```

The wrapper does not deploy anything, access production credentials, or change the evidence boundary for #167. A successful host-side publication is still not physical WebGPU, multi-browser relay/latency, or worker-loss/resume evidence.
