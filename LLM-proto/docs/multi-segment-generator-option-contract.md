# Multi-segment generator option contract

The budgeted split generator treats its Python API options as runtime inputs, not as values made trustworthy by type annotations.

Before source-model reads, output-directory creation, staging-directory creation, ONNX parsing, partition planning, or artifact writes, both `prepare_budgeted_multi_split()` and the safer staged `prepare_budgeted_multi_split_atomic()` entry point validate:

- `hidden_size`: positive Python integer;
- `target_bytes`: positive Python integer;
- `preferred_max_bytes`: positive Python integer;
- `target_bytes <= preferred_max_bytes`;
- `preferred_max_bytes <= PREFERRED_MAX_BYTES`, so callers cannot relax the product browser-artifact policy;
- `hash_source_external_data`: an actual Python boolean.

Booleans are rejected for the integer options even though `bool` is an `int` subclass in Python. Floats, strings, `None`, and other asserted runtime values are also rejected instead of being coerced or failing later with incidental comparison/ONNX errors.

Both public programmatic entry points independently validate `hash_source_external_data` before their own filesystem or source-read side effects. They do not use Python truthiness to decide whether provenance hashing runs: literal `True` enables the existing source external-data digest path and literal `False` intentionally skips that source digest while leaving generated shard hashes mandatory. Values such as `None`, `0`, `1`, empty strings, and `"false"` are rejected rather than being coerced.

The downstream shared `source_file_snapshot.measure_regular_file()` helper independently enforces the same exact-boolean contract for its lower-level `hash_file` switch before path resolution, open, or payload reads. This defense-in-depth keeps direct and future callers from using Python truthiness either to skip a requested external-data digest or to trigger an unexpected potentially large hash read.

The command-line interfaces already produce the expected integer and boolean values. These boundaries exist for programmatic callers and tests that can bypass CLI parsing. The staged publisher validates before creating its output or temporary staging directory, then the underlying generator validates the same runtime contract again when it receives the options. The duplicated cheap checks keep both public programmatic entry points independently fail-closed rather than relying on wrapper-only validation.

This is a structural fail-closed guarantee only. It does not provide new evidence that a real `Llama-3.2-1B-Instruct` q4 artifact fits the target budget or executes successfully on physical WebGPU hardware.
