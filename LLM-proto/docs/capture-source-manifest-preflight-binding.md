# Capture source-manifest / preflight binding

`capture_multi_segment_evidence_run.py` treats the generated `split-manifest.json` as a runtime trust boundary before any numerical verification starts.

The source-provenance check now reads the manifest through the existing descriptor-stable JSON snapshot reader. JSON parsing and SHA-256 are therefore derived from the same regular-file bytes, with pathname replacement, non-regular inputs, and mutation during the read rejected.

The SHA-256 returned by that provenance read is then compared with the `manifestSha256` reported by the immediately following `verify_artifact_snapshot()` preflight. A mismatch fails closed before `collect_evidence()` runs. This prevents the capture runner from validating `sourceModel.sha256` from one manifest object and numerically verifying artifacts rooted in a different replacement manifest.

This boundary does not claim to make ONNX Runtime descriptor-only. The existing preflight/evidence/postflight checks remain responsible for later artifact drift, while this check specifically closes the gap between source-provenance validation and the first artifact snapshot preflight.
