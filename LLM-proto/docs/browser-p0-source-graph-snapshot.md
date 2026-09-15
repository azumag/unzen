# Browser P0 source-graph snapshot boundary

`tools/prepare_browser_p0.py` verifies the pinned SmolLM2-135M q4 ONNX graph before split/repack generation starts. The source graph hash is provenance input, so the bytes hashed must belong to one stable regular-file snapshot rather than to whichever object a mutable pathname happens to reference at each filesystem operation.

The P0 wrapper now resolves the requested path once, validates the resolved target as a regular file, opens it read-only with nonblocking/no-follow flags where supported, and binds the opened descriptor to the pre-open file snapshot. SHA-256 is calculated only from that descriptor. The read fails closed if the descriptor metadata or observed byte count changes, and the requested/resolved pathname identity is checked again after hashing.

A stable symlink to a regular source graph remains supported. Retargeting the symlink, replacing the resolved pathname, substituting a FIFO/device, or mutating the file while it is being hashed is rejected before the pinned digest can be accepted.

This is host-side provenance hardening for the browser P0 preparation path. It does not alter segmentation, artifact budgets, runtime/cache/dispatcher behavior, or provide new real Llama-3.2-1B WebGPU evidence for #167. #158 remains outside this boundary and stays on HOLD.

Regression coverage lives in `tools/tests/test_prepare_browser_p0_source_snapshot.py`.
