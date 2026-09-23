# Browser checkpoint relay receipt boundary

The real two-segment WebGPU browser harness treats the Coordinator checkpoint receipt as untrusted transport input.

Segment 0 reads a successful checkpoint relay response through the same bounded streaming reader used for browser artifact boundaries. The receipt is limited to 16 KiB, which is intentionally small because the response contains only checkpoint binding metadata rather than tensors or model artifacts. The reader enforces the byte ceiling before JSON parsing and cancels rejected or oversized response streams according to the shared browser reader contract.

Accepted receipt bytes are decoded with `TextDecoder('utf-8', { fatal: true })` before `JSON.parse()`. Malformed UTF-8 therefore fails closed instead of being replacement-decoded. A normal UTF-8 BOM remains compatible with the platform decoder.

After parsing, the existing segment-0 binding checks remain authoritative: the receipt must match the loaded `manifestDigest` and provide both `checkpointId` and `checkpointDigest`. Abort checks around the relay path are unchanged.

This change is browser transport/input-integrity hardening only. It does not alter the Coordinator receipt schema, checkpoint identity semantics, model execution behavior, deployment state, or evidence/readiness status.
