# Browser P0 artifact-budget validation contract

`tools/prepare_browser_p0.py` measures the generated ONNX graph plus its segment-local external-data files before a browser P0 manifest is accepted.

The validation contract is fail-closed:

- artifact paths must satisfy the shared cross-platform relative-path contract and remain inside the preparation output directory after resolution;
- external-data byte counts must match the generated manifest;
- each shard is classified against the fixed browser tiers (preferred <=256 MiB, normal <=512 MiB, degraded <=1 GiB, rejected above 1 GiB);
- the caller-selected required tier must be satisfied by every segment.

Budget metadata is committed atomically. `browserArtifactBytes`, `browserArtifactTier`, and the top-level `browserArtifactBudget` object are added only after every segment has been measured and the required-tier gate has passed. If any later segment is missing, malformed, has byte-size drift, or exceeds the required tier, the budget validator raises without leaving partial budget annotations on the caller-owned manifest.

This contract protects preparation/reporting state only. It does not upgrade the evidence level of #167: real WebGPU execution, physical GPU working-set measurements, multi-browser relay, and worker-loss resume still require their respective runtime evidence.
