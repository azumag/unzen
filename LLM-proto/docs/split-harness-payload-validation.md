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

Before Browser B reconstructs the relayed tensors, the runner also requires the two names to match the current split manifest exactly. This keeps a structurally valid but wrong-boundary checkpoint from being consumed as the model's continuation input.

## Browser logits validation

Before a result report is constructed, the browser runner validates the actual logits tensor:

- the output exists and is `float32` or `float64`;
- the shape is positive rank 3 with batch size 1;
- `data.length` exactly matches the shape product;
- every logit is finite, not only the winning value;
- argmax is computed only after those checks pass.

An empty sequence/vocabulary, truncated tensor, NaN, or positive/negative Infinity therefore fails locally and never reaches the `pass` report path.

## Final result boundary

`POST /api/runs/:runId/result` only stores a successful result when the browser profile identity checks pass and the result contains a numerically meaningful output:

- `status` is `pass`;
- relay ownership is `coordinator` and direct worker networking is `false`;
- `logitsShape` is a positive rank-3 shape with batch size 1;
- `top1TokenId` is an integer within the reported vocabulary dimension;
- `top1Logit` is a finite number;
- input token IDs are a non-empty array of non-negative integers;
- observed boundary bytes are a positive integer.

The Coordinator-side checks are a second fail-closed boundary: missing outputs or JSON-normalized non-finite values such as `null` are rejected even if a caller bypasses the normal browser runner.

These checks validate evidence structure and numeric sanity only. They do not upgrade the evidence level, replace full-vs-split numerical comparison, or prove that a WebGPU execution was independently captured and verified.
