# Canonical source external-data paths

Issue: #967  
Parent: #167

`tools/verify_multi_segment_capture_source.py` re-binds a published capture to the original full ONNX graph and source external-data files on disk. External-data locations are provenance identities as well as filesystem paths, so a single filesystem object must not be accepted under multiple lexical spellings.

Before any source graph or external-data payload is hashed, each recorded external-data `location` must therefore be a canonical relative path. The verifier rejects:

- explicit `.` components such as `./weights.bin` or `dir/./weights.bin`;
- the Windows-separator equivalent such as `dir\.\weights.bin`;
- repeated `/` or `\` separators;
- trailing separators;
- the already-rejected absolute paths, drive/root forms, `..` traversal, colon-bearing components, and reserved Windows device names.

Ordinary nested paths such as `nested/weights.bin` remain valid. The same canonical lexical contract is used by the offline source-provenance verifier, so the on-disk and persisted-bundle audit paths no longer disagree about whether lexical aliases are distinct identities.

This is host-side audit hardening only. It does not add physical WebGPU evidence, multi-browser relay/resume evidence, production deployment guarantees, or any new claim for the operational HOLD in #158.
