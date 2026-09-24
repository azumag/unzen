# Split harness payload validation

The localhost two-browser WebGPU harness treats checkpoint and result payloads as evidence, so transport success alone is not enough for a `pass` result.

## JSON request transport boundary

Coordinator JSON requests are collected under the existing 16 MiB body ceiling and then decoded as UTF-8 with fatal error handling before `JSON.parse()` runs. Malformed UTF-8 is rejected with HTTP 400 before worker registration, checkpoint storage, result storage, or other route-specific state mutation. Valid non-ASCII UTF-8 continues to use the same route and payload-validation semantics; an empty request body still maps to `{}` before normal field validation.

This boundary prevents the runtime from silently replacing malformed byte sequences with U+FFFD and then accepting the normalized text as evidence-bearing JSON. It does not change route schemas, checkpoint/result binding, or the 16 MiB transport ceiling.

## Tokenizer output boundary

Before Browser A creates the segment-0 `input_ids` tensor or publishes checkpoint evidence, tokenizer output is normalized through a narrow explicit contract instead of generic JavaScript `Number(...)` coercion. The harness accepts a direct token array, a tokenizer object exposing `tolist()`, or exactly one leading batch dimension. The resulting token list must be non-empty.

Each token ID must already be either a non-negative safe-integer JavaScript `number`, or a non-negative `bigint` no larger than `Number.MAX_SAFE_INTEGER`. Safe `bigint` values are explicitly converted to numbers because int64 tokenizer implementations may legitimately expose that representation. Strings, booleans, `null`, fractions, negative values, unsafe numbers, oversized/negative bigints, empty batches, and multiple batches fail closed before model feed construction or checkpoint publication.

## Checkpoint boundary

`POST /api/runs/:runId/checkpoint` accepts exactly two boundary tensors. Each tensor must have:

- a unique, non-empty name;
- a supported ONNX Runtime scalar type;
- a non-empty, strictly positive integer shape;
- a declared byte count equal to `product(dims) * dtypeBytes`;
- canonical base64 whose decoded byte length exactly matches the declared/expected byte count.

Malformed, duplicate, truncated, oversized-by-declaration, or shape/byte-inconsistent tensors are rejected before they are stored as Coordinator evidence. The Coordinator computes the accepted `tensorBytes` value from the validated shape/type rather than trusting the client-provided aggregate.

Before Browser B reconstructs the relayed tensors, the runner now revalidates the checkpoint consumer contract rather than trusting the stored checkpoint solely because it came back from the Coordinator. Input token IDs must still be a non-empty array of non-negative safe integers before the existing `map(Number)` copy runs, so strings, booleans, nulls, fractions, negatives, and unsafe integers cannot be normalized into continuation input. The runner also requires the two boundary names to match the current split manifest exactly, requires every tensor type to equal the manifest `boundary.dtype`, recomputes the byte count from type and positive integer dimensions, and checks canonical base64 plus decoded byte length before `atob()` or typed-array construction runs. This consumer-side validation is intentionally redundant with the Coordinator ingress gate so a malformed or corrupted checkpoint response fails closed before model continuation input is allocated.

## Browser logits validation

Before a result report is constructed, the browser runner validates the actual logits tensor:

- the output exists and is `float32` or `float64`;
- the shape is positive rank 3 with batch size 1, and every dimension is already an actual numeric safe integer rather than a coercible string/boolean/null value;
- `data.length` exactly matches the shape product;
- every logit is already an actual JavaScript number and is finite, not merely coercible through `Number(...)`;
- argmax is computed from those validated values only after the checks pass.

An empty sequence/vocabulary, truncated tensor, coercible dimension/value, NaN, or positive/negative Infinity therefore fails locally and never reaches the `pass` report path. This keeps browser result evidence bound to the numeric tensor values ONNX Runtime actually produced instead of accepting a normalized JavaScript lookalike from a malformed or mocked runtime boundary.

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
