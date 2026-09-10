# Multi-segment capture postflight artifact snapshot gate

Issue #360 extends the #167 host-side capture path so the generated split artifact set is checked both before and after the numerical verification window.

## Why this exists

`capture_multi_segment_evidence_run.py` already performs a stable artifact snapshot preflight before starting the provenance-rich full-vs-multi ONNX Runtime verification. The numerical collector also embeds an artifact-integrity report and that report is bound back to the preflight identity.

That still left a narrower timing gap: a split manifest, segment graph, or external-data file could change while numerical verification was running and remain changed until publication. The numerical evidence would then refer to the earlier artifact bytes while the published capture directory contained the later bytes.

The runner now performs `verify_artifact_snapshot()` a second time after numerical verification and before writing evidence or the run summary. Publication is refused unless the preflight and postflight agree on:

- path-resolution mode;
- manifest SHA-256;
- segment count;
- declared artifact file count;
- every declared artifact field/path/byte-count/SHA-256 tuple;
- maximum segment artifact bytes; and
- the effective required maximum bytes.

Any mismatch is treated as tooling/evidence-integrity failure. The staging directory is removed and the requested destination remains absent.

## Numerical failures remain useful evidence

A full-vs-multi numerical mismatch is still publishable as `status=fail` when the artifact snapshot is unchanged across the numerical window. This preserves the existing distinction between a valid failed measurement and an invalid capture whose artifact identity drifted.

## Evidence boundary

This gate proves that the stable byte-level artifact snapshot observed immediately before numerical verification matches the stable snapshot observed immediately after it. It does not make ONNX Runtime consume already-open file descriptors.

In particular, it does **not** prove absence of a privileged transient pathname swap that occurs after preflight and is completely restored before postflight. Closing that stronger race would require changing how model files are opened/held for the numerical execution path rather than merely adding another snapshot check.

This change remains diagnostic-only. It does not establish WebGPU execution, GPU device-memory accounting, multi-browser checkpoint relay/resume, or a production physical-layout decision, and it does not change the #158 HOLD boundary.
