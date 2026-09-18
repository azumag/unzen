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

The browser P0 wrapper applies the same fail-closed rule at its own programmatic boundary. `prepare_browser_p0()` requires `hash_source_external_data` to be an exact Python boolean and `require_tier` to be one of the product `TIER_LIMITS` values before pinned-source verification or split generation starts. This keeps invalid wrapper controls from causing source hashing or shard work before a downstream helper rejects them, while literal `True`/`False` and every supported tier retain their existing semantics.

The direct two-segment `split_model()` entry point also validates its programmatic controls before reading the source graph or creating the output directory. `split_layer` and `hidden_size` must be exact positive Python integers, `external_data_mode` must be `symlink`, `copy`, or `none`, and `hash_external_data` must be an exact Python boolean. Model-dependent split-boundary validation still runs after parsing; the preflight only rejects values that can never be valid and prevents malformed controls from causing source or output side effects first.

The lower-level `materialize_external_data()` helper is also a direct programmatic trust boundary. It validates `mode` before inspecting locations, then preflights the complete location sequence before source filesystem checks or destination mutation. Every location must be a non-empty string, relative, and free of `..` path components. For `copy` and `symlink`, it then verifies that every referenced source both exists and resolves to a regular file before creating directories, unlinking destinations, copying, or creating destination symlinks. A symlink whose target is a regular file remains valid because `Path.is_file()` follows the source symlink. A missing, directory, broken symlink, or other unsupported non-regular source therefore fails before any earlier destination can be partially replaced. `none` deliberately stops after location preflight and performs no source lookup. Safe nested relative locations retain the existing `copy`, `symlink`, and `none` behavior.

The downstream shared `source_file_snapshot.measure_regular_file()` helper independently enforces the same exact-boolean contract for its lower-level `hash_file` switch before path resolution, open, or payload reads. This defense-in-depth keeps direct and future callers from using Python truthiness either to skip a requested external-data digest or to trigger an unexpected potentially large hash read.

The command-line interfaces already produce the expected integer and boolean values. These boundaries exist for programmatic callers and tests that can bypass CLI parsing. The staged publisher validates before creating its output or temporary staging directory, then the underlying generator validates the same runtime contract again when it receives the options. The duplicated cheap checks keep both public programmatic entry points independently fail-closed rather than relying on wrapper-only validation.

This is a structural fail-closed guarantee only. It does not provide new evidence that a real `Llama-3.2-1B-Instruct` q4 artifact fits the target budget or executes successfully on physical WebGPU hardware.
