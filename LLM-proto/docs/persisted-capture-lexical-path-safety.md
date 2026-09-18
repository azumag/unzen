# Persisted capture lexical path safety

The persisted capture bundle and artifact snapshot verifiers treat a declared path as an identity-bearing string before any `PurePath` or filesystem normalization occurs.

For `run-summary.json` control locators handled by `verify_multi_segment_capture_bundle.py` and graph/external-data locators handled by `verify_multi_segment_artifact_snapshot.py`, the verifier fails closed when the original text contains:

- ASCII C0 control characters (`U+0000` through `U+001F`) or `U+007F` DEL;
- an empty lexical component, including repeated, leading, or trailing `/` or `\\` separators;
- an explicit `.` lexical component.

Those checks happen before path resolution or artifact payload I/O. Existing absolute-path, traversal, Windows drive/root/ADS, reserved-device-name, containment, symlink, file-identity, digest, and byte-budget checks remain in force afterward.

Ordinary nested Unicode names remain valid. This keeps persisted capture control paths and artifact snapshot paths aligned with the source/numerical provenance path grammar while avoiding filesystem-dependent normalization aliases such as `a//b` and `a/./b`.
