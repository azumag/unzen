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
- raw external-data location spelling is canonical before `PurePath` / filesystem normalization: leading/trailing/repeated `/` or `\\` separators, explicit `.` components, empty components, ASCII control characters, and DEL are rejected;
- external-data locations are unique by portable identity as well as exact spelling: ASCII case aliases and `/` versus `\\` separator aliases are rejected before source filesystem identity checks;
- the resolved source graph path is reserved for the graph role and cannot also be declared as external data;
- external-data locations are globally unique by resolved filesystem path, so filesystem aliases such as symlinked names cannot name the same payload twice;
- every `bytes` field is a non-negative integer (booleans and coercible strings are rejected);
- every external-data entry has a canonical lowercase `sha256` digest.

The lexical and portable-identity checks intentionally match the persisted capture-source audit boundary. A numerical evidence producer therefore cannot accept a source external-data spelling that the later capture-source verifier rejects solely because of canonical path grammar or common Windows path identity. Portable case folding is ASCII-only; non-ASCII text is not locale-folded.

After metadata validation, but still before payload hashing, the verifier stats the source graph and every declared external-data file. Each role must resolve to a regular file with a distinct `(st_dev, st_ino)` filesystem identity. This rejects graph↔external and external↔external hard-link aliases before a large source graph or any earlier external-data payload is streamed through SHA-256.

If any later entry is malformed, has a portable path alias, aliases the source graph path, aliases an earlier resolved external-data path, or hard-links to an already claimed source provenance object, the verifier fails before hashing the source graph or any earlier external-data payload. Portable aliases are rejected before `_source_file_identity()` as well, so an immutable metadata conflict does not trigger source artifact filesystem I/O first. This is a fail-fast performance and trust-boundary guarantee; it does not weaken the measured identity checks.

## Authoritative measured identity

After metadata and filesystem-object preflight succeed, descriptor-pinned `_measure_file()` calls remain authoritative for content provenance. The verifier still streams the source graph and every external-data file and compares the observed size/digest with the preflighted metadata. Missing files, in-place mutation, byte-size mismatches, and SHA-256 mismatches continue to fail closed.

The filesystem-object check is intentionally a cheap preflight rather than a new publication or snapshot-isolation contract. It preserves the existing path/symlink policy and does not replace the measured SHA-256/byte checks.

The emitted `sourceModel` verification report is unchanged for valid manifests: it records graph byte size/digest, each original external-data location/byte size/digest, and `allExternalDataHashed: true`.

## Scope

This hardening is host-side numerical-evidence reliability for #167 / #943 / #945 / #947 / #949. It does not change ONNX Runtime provider policy, browser artifact layout, production deployment, credentials, billing, or count as new real-browser/WebGPU evidence.