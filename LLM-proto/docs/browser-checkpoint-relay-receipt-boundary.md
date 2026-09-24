# Browser Coordinator metadata receipt boundaries

The real two-segment WebGPU browser harness treats metadata-only Coordinator success responses as untrusted transport input.

Segment 0 reads the checkpoint relay receipt through a bounded streaming reader before validating `manifestDigest`, `checkpointId`, and `checkpointDigest`. Segment 1 applies the same boundary to the result acceptance receipt before validating `profileIsolationConfirmed` and the checkpoint binding. Each receipt is limited to 16 KiB, which is intentionally small because these responses contain binding/status metadata rather than tensors or model artifacts.

Both paths share the same bounded JSON decode primitive. The reader enforces the byte ceiling before JSON parsing and cancels rejected or oversized response streams according to the shared browser reader contract. Accepted bytes are decoded with `TextDecoder('utf-8', { fatal: true })` before `JSON.parse()`, so malformed UTF-8 fails closed instead of being replacement-decoded. A normal UTF-8 BOM remains compatible with the platform decoder.

After structural validation, both success receipts are also bound to the browser run selected by the immutable `run` query parameter used by `runner-v3.js` for Coordinator requests. If no `run` parameter is present, the existing `demo` fallback is the expected run ID. A structurally valid checkpoint or result receipt whose `runId` names another run is rejected before segment-completion or split-inference-completion reporting. Focused tests may pass the same expected run ID explicitly instead of depending on browser globals.

The existing semantic checks remain authoritative after parsing: segment 0 additionally binds the receipt to the loaded manifest and segment 1 requires confirmed browser-profile isolation plus the exact checkpoint ID/digest it consumed. Abort checks around both response paths are unchanged.

This is browser transport/input-integrity hardening only. It does not alter Coordinator receipt schemas, checkpoint identity semantics, model execution behavior, deployment state, or evidence/readiness status.
