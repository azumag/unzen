# Checkpoint shape runtime boundary

Unzen's hidden-state checkpoint contract is a three-dimensional tensor shape: `[batch, sequenceLength, hiddenSize]`. The checkpoint transfer serializer, feasibility reports, and runtime consumers already use that rank, so the in-memory checkpoint boundary enforces the same contract before accepting worker-owned runtime values.

`CheckpointStore` checks `metadata.shape.length === 3` before it allocates or iterates according to that length. Each of the three dimensions must still be a positive JavaScript safe integer. This prevents asserted, decoded, or Proxy-backed arrays from turning validation into a large length-derived allocation or leaking a native `RangeError` before a protocol error is reported.

The lazy worker-result ownership boundary follows the same rule. It reads an Array/Proxy shape length once. A valid rank copies exactly three entries into an owned frozen array; an invalid rank becomes a small owned invalid snapshot that the `CheckpointStore` rejects. The boundary therefore preserves the existing single-read and mutation-isolation behavior without retaining a hostile caller-owned shape for later validation.

This change does not alter checkpoint relay ownership, retry/resume cost estimation, production persistence, or the worker-to-worker networking prohibition. It is runtime protocol hardening and does not count as new real-model, physical WebGPU, multi-browser relay, or worker-loss/resume evidence for #167.
