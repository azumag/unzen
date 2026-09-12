# Multi-segment numerical verifier runtime contract

`tools/verify_multi_segment_onnx.py` treats `split-manifest.json` as an untrusted
runtime input. The numerical gate validates the execution contract before it
creates an ONNX Runtime session; it does not normalize malformed JSON values
into plausible manifest fields.

The verifier requires exact JSON integers for segment indexes, layer bounds,
boundary layer indexes, split cut layers, and source external-data byte counts.
Booleans, numeric strings, and floats are rejected even when Python could coerce
them to the same integer. Artifact paths, SHA-256 digests, segment input/output
names, and boundary tensor names must be actual non-empty JSON strings. Existing
path-containment, Windows path-safety, contiguity, boundary, and logits-output
checks still apply after those type checks.

The full source graph and each source external-data file are measured through one
opened file descriptor per file. Byte size and SHA-256 therefore refer to the
same opened filesystem identity. An atomic pathname replacement after opening
cannot mix the old digest with the new target's size; an in-place mutation that
changes descriptor metadata while hashing fails closed. The source graph and
external-data digests still must match the immutable identities recorded by the
split manifest.

These checks bind same-machine numerical evidence to a canonical manifest and a
consistent source-file snapshot. They do not prove WebGPU execution, physical
GPU working-set behavior, distinct browser workers, Coordinator relay latency,
cache behavior, or worker-loss resume; those remain separate real-browser gates
for issue #167.
