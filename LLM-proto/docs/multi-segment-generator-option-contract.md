# Multi-segment generator option contract

The budgeted split generator treats its Python API options as runtime inputs, not as values made trustworthy by type annotations.

Before source-model reads, output-directory creation, staging-directory creation, ONNX parsing, partition planning, or artifact writes, both `prepare_budgeted_multi_split()` and the safer staged `prepare_budgeted_multi_split_atomic()` entry point validate:

- `hidden_size`: positive Python integer;
- `target_bytes`: positive Python integer;
- `preferred_max_bytes`: positive Python integer;
- `target_bytes <= preferred_max_bytes`;
- `preferred_max_bytes <= PREFERRED_MAX_BYTES`, so callers cannot relax the product browser-artifact policy.

Booleans are rejected even though `bool` is an `int` subclass in Python. Floats, strings, `None`, and other asserted runtime values are also rejected instead of being coerced or failing later with incidental comparison/ONNX errors.

The command-line interfaces already parse these options as integers. This boundary exists for programmatic callers and tests that can bypass CLI parsing. The staged publisher validates before creating its output or temporary staging directory, then the underlying generator validates again when it receives the trusted integer values. The duplicated cheap check keeps both public programmatic entry points independently fail-closed.

This is a structural fail-closed guarantee only. It does not provide new evidence that a real `Llama-3.2-1B-Instruct` q4 artifact fits the target budget or executes successfully on physical WebGPU hardware.
