# Complete capture audit report-container contract

`tools/audit_multi_segment_capture.py` composes the independent capture-bundle and source-model verifiers into the complete post-publication audit used by #167.

The delegated verifier return values are runtime inputs to this orchestration layer. Before the audit reads `kind`, `schemaVersion`, status, digests, path-resolution metadata, or any other field, each observation is required to be a JSON-object-shaped Python `dict`:

- the initial bundle verification report;
- the source verification report;
- the post-source bundle verification report; and
- the post-bundle source verification report.

A `None`, primitive, list/array, or any other non-object container fails closed with an explicit audit validation error. This keeps malformed verifier output inside the same deterministic contract-validation boundary as malformed report fields instead of leaking incidental `.get()`/attribute behavior.

Valid verifier reports retain the existing schema, status, digest, source-artifact, and path-resolution comparison semantics. This change does not alter artifact bytes or choose a segmentation/runtime strategy.

Regression coverage lives in `tools/tests/test_audit_multi_segment_capture_report_container.py`.

## Evidence boundary

This is host-side audit orchestration hardening only. It is not new real `Llama-3.2-1B-Instruct` q4 artifact-byte evidence, physical WebGPU evidence, multi-browser Coordinator relay/latency evidence, or worker-loss/resume evidence. It does not alter the production/deploy/credential/billing HOLD scope tracked separately in #158.
