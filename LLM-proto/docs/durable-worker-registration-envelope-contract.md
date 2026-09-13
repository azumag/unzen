# Durable worker-registration runtime envelope

`DurableCoordinator.registerWorker()` is a transport-facing trust boundary. TypeScript annotations do not validate values decoded from WebSocket/JSON messages, so the Coordinator validates the registration envelope before it performs the manifest minimum-VRAM preflight or delegates to `WorkerRegistry`.

The accepted runtime shape is:

- the registration itself is a non-null, non-array object;
- `workerId` is a non-empty string;
- `tier` is one of the closed `WorkerTier` values (`TIER_1`, `TIER_2`, `TIER_3`);
- `vramMB` is a positive finite JavaScript number;
- `connectionId` is a non-empty string.

Malformed values fail closed with `ErrorCode.ProtocolViolation` before the Coordinator performs numeric comparison, diagnostic interpolation, registry lookup, generation issuance/revocation, or lease reclaim. In particular, coercion-sensitive values such as `Symbol` or numeric strings cannot reach the manifest minimum-VRAM comparison.

After the runtime envelope passes validation, the existing model capability contract remains authoritative: a valid worker whose VRAM is below `manifest.runtimeRequirements.minimumVramMB` is rejected with `ErrorCode.UnsupportedRequest`.

Valid registration semantics are unchanged. Re-registering the same worker on the same connection refreshes capabilities while retaining the generation. Re-registering it on a different connection revokes the old generation, issues a new generation, and lets the Coordinator reclaim leases belonging to the previous generation.

This contract is runtime protocol hardening only. It does not change production deployment policy, credentials, billing, model segmentation policy, or the external evidence requirements tracked by the 1B WebGPU work.
