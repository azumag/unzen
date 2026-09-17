# Source-model provenance metadata preflight

`verify_multi_segment_onnx.verify_source_model_identity()` binds same-machine numerical evidence to the source ONNX graph and every declared source external-data file.

For 1B-class models, those payloads can be hundreds of MiB or larger. Configuration or manifest-shape errors therefore must not be discovered only after earlier source payloads have already been streamed through SHA-256.

## Fail-fast boundary

Before the first source `_measure_file()` call, the verifier now validates the complete immutable `sourceModel` metadata contract:

- `sourceModel` is an object;
- `sourceModel.sha256` is a canonical lowercase SHA-256 digest;
- `sourceModel.externalData` is an array;
- every external-data entry is an object;
- every `location` is non-empty and passes the existing safe-relative-path rules;
- external-data locations are globally unique by resolved filesystem path, so syntactic aliases such as `weights.bin` and `./weights.bin` cannot name the same payload twice;
- every `bytes` field is a non-negative integer (booleans and coercible strings are rejected);
- every external-data entry has a canonical lowercase `sha256` digest.

If any later entry is malformed or aliases an earlier resolved source path, the verifier fails before hashing the source graph or any earlier external-data payload. This is a fail-fast performance and trust-boundary guarantee; it does not weaken the measured identity checks.

## Authoritative measured identity

After metadata preflight succeeds, descriptor-pinned `_measure_file()` calls remain authoritative. The verifier still streams the source graph and every external-data file and compares the observed size/digest with the preflighted metadata. Missing files, in-place mutation, byte-size mismatches, and SHA-256 mismatches continue to fail closed.

The emitted `sourceModel` verification report is unchanged for valid manifests: it records graph byte size/digest, each original external-data location/byte size/digest, and `allExternalDataHashed: true`.

## Scope

This hardening is host-side numerical-evidence reliability for #167 / #943 / #945. It does not change ONNX Runtime provider policy, browser artifact layout, production deployment, credentials, billing, or count as new real-browser/WebGPU evidence. Resolved-path alias rejection does not claim inode/hard-link identity isolation; that requires a separate filesystem-object policy if needed.
