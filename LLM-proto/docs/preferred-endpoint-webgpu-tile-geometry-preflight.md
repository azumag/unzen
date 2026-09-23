# Preferred endpoint WebGPU tile-geometry preflight

The preferred endpoint ORT Web/WebGPU preparer is intentionally a narrow diagnostic: it uses the pinned 4-physical / 8-tile candidate, materializes physical artifact 0, and emits graphs for execution tiles 0 and 1 only.

Before opening or hashing the pinned 1.69 GB source external-data file, `prepare_llama_1b_endpoint_preferred_tile_ort_webgpu.py` now validates the complete geometry needed by that diagnostic and copies it into an owned snapshot. The preflight requires exactly one 4-way candidate, exactly one physical artifact 0 descriptor, the pinned artifact-0 byte length, strict non-bool integer row and byte fields, internally consistent row counts and byte lengths, one artifact-0 slice for each selected tile, and contiguous tile-0/tile-1 row and payload boundaries.

The expensive source hash and payload materialization start only after that preflight succeeds. Graph generation and manifest emission consume the owned snapshot rather than re-reading caller-owned candidate dictionaries, so later mutation of the upstream report cannot change the validated offsets or row ranges used by the probe.

This is fail-fast host-side hardening only. It does not change the preferred layout, the pinned payload hashes, the ORT Web version, the browser harness contract, or the evidence status of the real 1B/WebGPU work tracked by #167.
