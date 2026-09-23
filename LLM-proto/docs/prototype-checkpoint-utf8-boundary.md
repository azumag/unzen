# Simulated prototype checkpoint UTF-8 boundary

`two-worker-prototype.ts` models its relayed checkpoint as text encoded by `TextEncoder`, even though the production/model checkpoint abstraction represents binary tensor bytes. Segment 1 therefore treats **only this simulated text checkpoint** as strict UTF-8 input.

The worker first snapshots caller-owned `hiddenStates` into an owned `Uint8Array`, then validates those owned bytes with fatal UTF-8 decoding as part of the execution-envelope preflight. Malformed UTF-8 is rejected before Coordinator/CDN connection logging, cache mutation, or consumption of the simulated `failFirstRun` state. Valid prototype checkpoints produced by segment 0 remain unchanged, including relay byte accounting and output text.

This boundary must not be generalized to real model checkpoint tensors: arbitrary tensor bytes are binary data and do not have a UTF-8 contract. This is prototype input-integrity/reliability hardening only and does not add real-model, WebGPU, multi-browser, transport-authentication, or #167 readiness evidence.
