# Endpoint payload materialization verifier independence

This note records the trust boundary for the diagnostic verifier used by issue #223.

`materialize_endpoint_payload_chunks.py` is the producer of diagnostic source-byte payload evidence. `verify_endpoint_payload_materialization.py` must not treat producer-side blueprint, provenance, source-identity, validation, or hashing helpers as authoritative when deciding whether that evidence passes verification.

The verifier therefore owns a pinned copy of the currently accepted diagnostic contract:

- probe kind/schema and pinned source graph SHA-256;
- pinned `model_q4.onnx_data` location, byte size, and SHA-256;
- tied-embedding row count, row byte width, and source offset;
- allowed endpoint stage kinds and tier-specific payload counts;
- producer materialization kind/schema expected on input.

From those constants and the explicit `--stage` / `--tier`, the verifier deterministically reconstructs the expected row-aligned source-byte blueprint and canonical blueprint SHA-256. It then checks that the probe report contains exactly that blueprint before validating the producer report.

This is intentionally duplicated contract code rather than a shared producer helper. A producer regression that changes its own blueprint derivation, provenance construction, range validation, or hashing helper must not automatically redefine what the verifier accepts. Such drift should fail closed until the verifier contract is reviewed and updated independently.

The current preferred-tier blueprint remains four contiguous 32,064-row payloads covering bytes `[0, 1,050,673,152)` of the pinned tied embedding, with canonical blueprint SHA-256 `910499192b85812b804104db819bc149a0ba5784254e34e8d79fc52c149dd8db`.

The verifier still performs the source-backed checks introduced previously: complete source size/SHA-256, exact source-range hashes, exact payload hashes, report geometry, payload count and total bytes, exact `payload-*.bin` set, provenance, and input-report byte hashes. It also pins the dereferenced source and each payload file snapshot by device/inode/size/mtime/ctime metadata, requires every full-file and source-range hash to observe its expected snapshot before and after reading, and rechecks all snapshots before emitting a pass report. This prevents concurrent source or payload replacement/in-place mutation from mixing bytes from different filesystem snapshots into one verification result. Source symlinks remain supported for model-cache compatibility because the dereferenced target snapshot and bytes are independently checked; payload symlinks are rejected.

All resulting evidence remains `decisionStatus=diagnostic-only`. This independence improvement does not select vocabulary-axis chunking, define browser cache or manifest formats, alter loader/runtime/dispatcher behavior, relax the browser artifact policy, or resolve the major design decision in #223.
