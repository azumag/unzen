# Real two-browser Coordinator worker identity JSON boundary

Tracking: #1575. Parent technical-core work: #167.

The local split Coordinator treats worker identity fields as typed JSON input, not as values that can be converted into strings after parsing.

## Contract

The following request fields must already be JSON strings when they reach the Coordinator:

- registration `workerId`;
- registration `role`;
- checkpoint `sourceWorkerId`;
- result `segment1WorkerId`.

Worker IDs must additionally match the existing `^[A-Za-z0-9._-]{1,128}$` syntax. Registration roles remain limited to the exact strings `segment0`, `segment1`, and `standby`. The Coordinator does not trim, stringify, or otherwise normalize these values.

An explicitly supplied result `segment0WorkerId` is compared directly with the immutable source worker identity stored on the accepted checkpoint. The existing compatibility behavior for an omitted `segment0WorkerId` remains unchanged: profile-isolation validation falls back to the checkpoint source identity. A present array, number, boolean, or object is never allowed to alias that string identity through JavaScript coercion.

## Failure boundary

Malformed registration identities are rejected before worker state is written. Malformed checkpoint source IDs are rejected before checkpoint state is written, and malformed result worker identities are rejected before result/profile-isolation evidence is stored.

This keeps the browser/Coordinator identity boundary aligned with the other fail-closed JSON contracts: the semantic type used for authorization and evidence binding must be the type that was actually received on the wire.

## Evidence scope

This change is local Coordinator input-integrity hardening only. CI coverage for this boundary is not evidence of real 1B q4 artifact execution, physical WebGPU inference, distinct-browser relay/latency, worker-loss/resume, or cache residency, and it does not require deployment, credentials, billing, or model downloads.
