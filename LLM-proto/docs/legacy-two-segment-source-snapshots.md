# Legacy two-segment source snapshot boundary

The fixed two-segment `split_llama_1b_onnx.py` path now pins source provenance before it records it in `split-manifest.json`.

The source ONNX graph is captured once from a bounded read-only regular-file descriptor. ONNX parsing uses those captured bytes with `load_external_data=False`, and `sourceModel.sha256` is calculated from the same bytes. A pathname replacement can therefore no longer make the graph used for splitting differ from the graph digest recorded in the manifest.

Each referenced source external-data file is similarly measured through one pinned regular-file identity. Manifest `bytes` and, when enabled, `sha256` come from that identity. Stable symlinks remain supported, while path-to-open replacement, non-regular resolved targets, read/hash-time mutation or growth, resolved-target replacement, and requested-path retargeting fail closed. `--skip-external-digest` remains size-only and does not force a full payload read.

This change deliberately leaves the fixed split layer, graph extraction, external-data `copy`/`symlink`/`none` materialization modes, manifest schema, and runtime checker behavior unchanged. Materialization itself is still a later pathname-based phase rather than one long-lived descriptor transaction, so a privileged transient mutation that is completely restored between phases remains outside this guarantee.

This is host-side provenance hardening only. It adds no physical WebGPU, browser working-set, multi-browser relay/latency, worker-loss/resume, production deployment, credential, or billing evidence.

Related: #167, #858.
