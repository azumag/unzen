# Split harness payload validation

The localhost two-browser WebGPU harness treats checkpoint and result payloads as evidence, so transport success alone is not enough for a `pass` result.

## Checkpoint boundary

`POST /api/runs/:runId/checkpoint` accepts exactly two boundary tensors. Each tensor must have:

- a unique, non-empty name;
- a supported ONNX Runtime scalar type;
- a non-empty, strictly positive integer shape;
- a declared byte count equal to `product(dims) * dtypeBytes`;
- canonical base64 whose decoded byte length exactly matches the declared/expected byte count.

Malformed, duplicate, truncated, oversized-by-declaration, or shape/byte-inconsistent tensors are rejected before they are stored as Coordinator evidence. The Coordinator computes the accepted `tensorBytes` value from the validated shape/type rather than trusting the client-provided aggregate.

## Final result boundary

`POST /api/runs/:runId/result` only stores a successful result when the browser profile identity checks pass and the result contains a numerically meaningful output:

- `status` is `pass`;
- relay ownership is `coordinator` and direct worker networking is `false`;
- `logitsShape` is a positive rank-3 shape with batch size 1;
- `top1TokenId` is an integer within the reported vocabulary dimension;
- `top1Logit` is a finite number;
- input token IDs are a non-empty array of non-negative integers;
- observed boundary bytes are a positive integer.

This means runner failures such as an empty logits sequence or all-NaN logits cannot be persisted as successful evidence: their non-finite top-1 value becomes invalid JSON data (for example `null`) and the Coordinator rejects the result.

These checks validate evidence structure and numeric sanity only. They do not upgrade the evidence level, replace full-vs-split numerical comparison, or prove that a WebGPU execution was independently captured and verified.
