# Multi-segment generator option contract

The budgeted split generator treats its Python API options as runtime inputs, not as values made trustworthy by type annotations.

Before source-model reads, output-directory creation, ONNX parsing, partition planning, or artifact writes, `prepare_budgeted_multi_split()` validates:

- `hidden_size`: positive Python integer;
- `target_bytes`: positive Python integer;
- `preferred_max_bytes`: positive Python integer;
- `target_bytes <= preferred_max_bytes`;
- `preferred_max_bytes <= PREFERRED_MAX_BYTES`, so callers cannot relax the product browser-artifact policy.

Booleans are rejected even though `bool` is an `int` subclass in Python. Floats, strings, `None`, and other asserted runtime values are also rejected instead of being coerced or failing later with incidental comparison/ONNX errors.

The command-line interface already parses these options as integers. This boundary exists for programmatic callers and tests that can bypass CLI parsing, including the staged publisher used by the #167 real-1B workflow.

This is a structural fail-closed guarantee only. It does not provide new evidence that a real `Llama-3.2-1B-Instruct` q4 artifact fits the target budget or executes successfully on physical WebGPU hardware.
