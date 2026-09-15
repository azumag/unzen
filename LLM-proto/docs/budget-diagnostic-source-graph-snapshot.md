# Budget diagnostic source graph snapshot boundary

`tools/diagnose_multi_segment_budget.py` feeds the pinned 1B endpoint envelope/layout diagnostics, so the ONNX graph semantics used for budget calculations must be bound to the graph identity emitted in `sourceModel`.

The diagnostic now resolves the requested source target once, requires a bounded regular file, pins it with a read-only nonblocking descriptor, verifies path/descriptor identity before and after the read, and captures the complete graph bytes. The ONNX model is parsed from an in-memory stream over exactly those captured bytes, while `graphBytes` and `graphSha256` are derived from the same byte snapshot.

Path replacement, non-regular inputs such as FIFOs, growth beyond the graph limit, or in-place mutation while reading fail closed before partition or endpoint-isolation calculations begin. External-data payloads are still not loaded by this graph-only diagnostic.

This is host-side diagnostic integrity hardening only. It does not change browser artifact budgets, choose an endpoint physical/execution layout, or add physical WebGPU or multi-browser evidence for #167.
