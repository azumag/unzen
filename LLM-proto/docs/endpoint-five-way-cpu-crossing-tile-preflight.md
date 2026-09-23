# Five-way CPU crossing-tile preflight

`tools/probe_llama_1b_endpoint_five_way_tile_ort_cpu.py` validates the selected diagnostic crossing-tile layout before it opens or hashes the pinned source external-data payload.

The preflight boundary now requires:

- one canonical five-physical-artifact candidate with eight indexed execution tiles;
- canonical physical artifact indices and bounded source ranges whose lengths match their descriptors;
- strict non-boolean integer tile, slice, source-range, artifact-offset, and byte-length geometry;
- exactly two physical slices for each selected boundary-crossing tile;
- slice row/byte geometry consistent with `rowBytes` and the containing physical artifact;
- two distinct physical artifacts per selected crossing tile;
- ordered, gap-free slice rows that cover each selected tile exactly.

The selected tiles, required physical-artifact descriptors, and pinned source identity are copied into owned snapshots. Source verification, per-artifact payload verification, temporary ORT graph construction, and CPU execution consume those snapshots instead of rereading caller-owned layout dictionaries after expensive payload I/O begins.

This change is fail-fast host-side reliability hardening only. It does not select the five-way endpoint layout, change CPU numerical tolerances or ONNX Runtime semantics, or add WebGPU/multi-browser evidence.
