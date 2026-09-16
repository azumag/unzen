# Multi-segment source external-data snapshot boundary

The budgeted multi-segment generator records source external-data metadata before it starts planning or materializing browser shards. Each referenced external-data file is now measured through one read-only descriptor identity rather than a sequence of independent pathname observations.

For every referenced `location`, the generator resolves the requested path, requires the resolved target to be a regular file, opens it with nonblocking/no-follow flags where the platform provides them, and verifies that the opened descriptor still matches the checked target. The manifest `bytes` value comes from that descriptor identity. When source external hashing is enabled, SHA-256 is computed by reading that same descriptor and the generator rejects size/mtime/ctime/inode drift or a byte count that does not match the final descriptor size. The resolved pathname and the original requested path are checked again after measurement so stable symlinks remain supported while retargeting is rejected.

`--skip-source-external-digest` intentionally remains a size-only mode. It still opens and pins a regular-file identity for byte-length and external-range validation, but it does not read the complete payload merely to prove that hashing was skipped. This preserves the existing performance intent of the option.

The boundary is host-side generator integrity only. It prevents a source manifest entry from combining the size/range validation of one file instance with the digest of another, and it fail-closes on path-to-open replacement, non-regular resolved targets, hash-time mutation/growth, resolved-target replacement, and requested-path retargeting. It does not turn the later segment repack phase into one long-lived descriptor transaction, and it does not claim protection against a privileged transient mutation that is fully restored between independent generator phases. It provides no new physical WebGPU, browser working-set, multi-browser relay, latency, or worker-loss evidence.

Related: #167, #856.
