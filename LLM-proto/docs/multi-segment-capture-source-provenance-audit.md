# Multi-segment capture source-provenance audit

Issue: #362  
Parent: #167

## Purpose

`capture_multi_segment_evidence_run.py` publishes a host-side diagnostic bundle containing:

- `run-summary.json`
- `same-machine-evidence.json`
- `split/split-manifest.json`
- generated segment graph/external-data artifacts

`verify_multi_segment_capture_bundle.py` already re-hashes and cross-binds the published summary, numerical evidence, manifest, generated artifacts, parameters, and capture status. The source-model graph digest is also bound between the summary and the numerical verification.

The split manifest additionally records source external-data identity (`location`, byte size, and SHA-256), while the numerical verifier independently measures the source external data before ONNX Runtime execution. `verify_multi_segment_capture_source_provenance.py` makes the equality of those two source identities an explicit offline gate.

## Usage

```bash
cd LLM-proto
python tools/verify_multi_segment_capture_source_provenance.py \
  --capture-dir /path/to/capture
```

The command first requires the existing full bundle verifier to pass. It then re-reads the exact summary, evidence, and manifest bytes with bounded stable regular-file reads and requires their SHA-256 digests to remain identical to the base verifier result. On platforms exposing `O_BINARY`, those JSON control descriptors request binary mode so byte counts and SHA-256 remain bound to the exact persisted bytes rather than CRT text-mode newline/control-character translation; POSIX behavior is unchanged. After the source graph/external-data identities have been cross-bound, it re-reads all three selected JSON controls again before returning success and requires those final digests to equal the same base-bundle digests. This start/end binding prevents the offline audit from reporting `status=pass` while one of the published controls has moved to a different byte snapshot during the audit.

The final check is deliberately byte/digest based rather than a long-lived pathname inode lock. A temporary replacement that ends with exactly the same bytes remains the same persisted evidence identity. This does not provide reader-isolated publication for generated segment paths or select the publication/cache-key policy tracked separately in #908.

A passing result requires:

1. `run-summary.sourceModel.graphSha256`
2. `split-manifest.sourceModel.sha256`
3. `same-machine-evidence.verification.sourceModel.graphSha256`

all to be the same canonical SHA-256 digest.

It also requires the split manifest and numerical verification to contain the exact same source external-data set. Each location must be a safe, canonical lexical relative path, unique, have a non-negative byte count, and have a canonical lowercase SHA-256 digest. Explicit `.` path segments, repeated separators, and trailing separators are not canonical: aliases such as `weights.bin` / `./weights.bin`, `dir/weights.bin` / `dir/./weights.bin`, or `dir/weights.bin` / `dir//weights.bin` are rejected rather than normalized into separate provenance identities.

Portable identity is checked independently of the host filesystem. Exact duplicates keep their existing diagnostic, while ASCII case-only aliases such as `weights/Chunk.bin` / `weights/chunk.bin` and slash/backslash aliases such as `weights/chunk.bin` / `weights\\chunk.bin` fail closed as the same portable source role. Non-ASCII text is not locale-folded; ordinary distinct Unicode locations remain valid. This keeps the offline manifest/evidence cross-bind aligned with the full source verifier and the numerical provenance producer.

The numerical verification must state `allExternalDataHashed=true`.

The output remains `decisionStatus=diagnostic-only`.

## Why this is separate from generated-artifact integrity

Generated segment integrity and source provenance answer different questions.

The generated-artifact snapshot verifier proves that the split manifest and generated segment files still match the byte-level artifact set that the capture recorded. Source provenance instead answers whether the manifest's declared source graph/external-data identity is the same source identity that the numerical verifier actually measured.

Keeping the second check explicit prevents a malformed or regressed capture from remaining offline-auditable merely because both the generated artifacts and the numerical evidence are internally self-consistent while referring to different source external-data identities.

## Proof boundary

A pass means only that the persisted capture bundle is internally cross-bound to one source graph/external-data identity and that the selected JSON control byte snapshots still match the base bundle at the end of this offline audit.

It does **not** prove:

- who authored or signed the evidence;
- that the original full-model files still exist;
- that re-running the original model would reproduce the same result;
- WebGPU execution or GPU device-memory reclamation;
- multi-browser checkpoint relay or worker-loss resume;
- correctness of a production physical layout or deployment policy.

Those remain separate #167 evidence gates. #158 production operations remain on HOLD until the technical-core prerequisites are met.
