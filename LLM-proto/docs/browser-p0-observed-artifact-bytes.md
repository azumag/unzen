# Browser P0 observed artifact byte accounting

`prepare_browser_p0.py` treats the browser artifact budget as a filesystem measurement, not as a restatement of manifest metadata.

For every generated segment, the budget pass now:

1. stats the generated ONNX graph file;
2. stats every generated external-data file declared by the segment;
3. requires each external-data manifest `bytes` value to match the observed file size;
4. sums the observed graph and external-data sizes;
5. derives the preferred / normal / degraded / rejected tier from that observed sum.

The pass fails closed before writing the browser budget report when a graph or external-data file is missing, when `externalData` is malformed, or when declared and observed external-data bytes differ. This prevents a stale split manifest from making a truncated or enlarged prepared artifact look compliant with the browser shard ceiling.

The policy thresholds are unchanged: target about 200 MiB, preferred at most 256 MiB, normal at most 512 MiB, degraded at most 1 GiB, and rejected above 1 GiB.

This is structural artifact verification only. It does not count as real WebGPU execution evidence, physical GPU working-set evidence, multi-browser relay evidence, or worker-loss resume evidence for #167.
