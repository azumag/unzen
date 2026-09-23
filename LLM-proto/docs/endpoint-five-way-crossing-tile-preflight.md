# Five-way crossing-tile preparation preflight

`tools/prepare_llama_1b_endpoint_five_way_tile_ort_webgpu.py` treats the endpoint-layout report as untrusted runtime input even though the current producer is pinned by the diagnostic workflow.

Before opening or hashing the pinned external-data payload, preparation now validates and snapshots the narrow five-way geometry it will use:

- exactly one five-physical-artifact candidate must exist;
- physical artifact descriptors must use canonical integer indices and valid bounded source ranges;
- selected execution tile 1 must remain the two-artifact crossing tile;
- tile and slice row geometry must use non-bool integers and agree with `rowBytes`;
- the two selected slices must use physical artifacts 0 then 1, be row-contiguous, and cover the selected tile exactly;
- each selected slice must remain within its physical artifact;
- physical artifacts 0 and 1 are copied only from source ranges captured by this preflight.

The validated values are copied into owned snapshots. Payload materialization, temporary graph construction, and manifest emission use those snapshots rather than rereading the caller-owned layout dictionaries after the expensive source hash begins.

This is fail-fast reliability hardening only. It does not select the five-way layout, change the pinned model or payload identity, change the browser experiment, or add new real WebGPU evidence.
