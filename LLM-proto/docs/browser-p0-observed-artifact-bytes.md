# Browser P0 observed artifact byte accounting

`prepare_browser_p0.py` treats the browser artifact budget as a filesystem measurement, not as a restatement of manifest metadata.

For every generated segment, the budget pass now:

1. validates graph and external-data locators with the same cross-platform relative artifact-path contract used by split/repack generation;
2. resolves each prepared file and requires it to remain inside the selected output directory;
3. stats the generated ONNX graph file;
4. stats every generated external-data file declared by the segment;
5. requires each external-data manifest `bytes` value to match the observed file size;
6. sums the observed graph and external-data sizes;
7. derives the preferred / normal / degraded / rejected tier from that observed sum.

POSIX/Windows absolute paths, drive or root paths, parent traversal, colon-bearing Windows components, reserved Windows device/port basenames, and trailing dot/space components are rejected before any artifact is measured. A lexically safe nested path whose symlink-resolved target escapes the output directory is also rejected. Ordinary nested relative artifact paths remain valid.

The pass fails closed before writing the browser budget report when a graph or external-data file is missing, when `externalData` is malformed, when declared and observed external-data bytes differ, or when an artifact path escapes the prepared output directory. This prevents a stale or modified split manifest from making a foreign, truncated, or enlarged artifact look compliant with the browser shard ceiling.

The policy thresholds are unchanged: target about 200 MiB, preferred at most 256 MiB, normal at most 512 MiB, degraded at most 1 GiB, and rejected above 1 GiB.

This is structural artifact verification only. It does not count as real WebGPU execution evidence, physical GPU working-set evidence, multi-browser relay evidence, or worker-loss resume evidence for #167.
