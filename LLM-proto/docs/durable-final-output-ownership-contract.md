# Durable final-output ownership contract

The durable result root is detached at the public `DurableCoordinator.acceptResult()` boundary. For a final segment, the nested `output` object is also treated as untrusted runtime input before the core validator and completion commit consume it.

## Field capture

The final-output snapshot keeps the existing validation order:

1. malformed non-object or array output containers are left for the existing core validator to reject;
2. `tokens` is read once;
3. when `tokens` is an array, its initial length is fixed and token values are read by numeric position into a fresh plain array;
4. each captured token is checked against the existing non-negative-safe-integer domain before progressing;
5. `text` is read once only after all captured tokens satisfy that domain.

The caller token array's iterator is never used by the snapshot. This prevents a custom `Symbol.iterator` from becoming part of result validation and ensures the later core validator and commit path operate on an ordinary owned array.

If a token is invalid, later caller token positions and the caller-owned `text` property are not read. If `tokens` is not an array, `text` is likewise not read. The existing durable core remains authoritative for the exact protocol-violation messages and completion state transition.

## Commit ownership

After the snapshot is constructed, repeated `result.output.tokens` / `result.output.text` reads inside the core observe only the owned output object. A valid-first / altered-second accessor therefore cannot make committed output differ from the values that were captured for validation.

This contract does not yet own the nested checkpoint envelope used by intermediate results. That boundary remains separate because checkpoint validation includes payload copying, digests, timing, and asynchronous integrity work.

## Evidence boundary

This is runtime ownership / TOCTOU hardening. It is not new physical WebGPU, real multi-browser relay, Llama q4 artifact, production deployment, credential, billing, or operator-authorization evidence for #167 or #158.
