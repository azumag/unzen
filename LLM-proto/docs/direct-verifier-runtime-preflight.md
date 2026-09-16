# Direct numerical verifier runtime preflight

The programmatic entry points `verify_multi_segment_onnx.verify_multi_split()` and
`verify_multi_segment_kv_decode.verify_multi_segment_kv_decode()` treat their runtime
arguments as untrusted input even when callers bypass the CLI and its argparse types.

Before either verifier reads or hashes `split-manifest.json`, verifies graph/external-data
artifacts, or creates an ONNX Runtime session, it validates and normalizes the runtime
configuration:

- token IDs must be non-negative integer-like values; `bool` is rejected;
- cached-decode `next_token_id` follows the same rule;
- `kv_heads` and `head_size` must be positive integer-like values; `bool` is rejected;
- `atol` and `rtol` must normalize to finite, non-negative numbers; `bool`, NaN, infinity,
  and negative values are rejected;
- `provider` must be an actual non-empty, non-whitespace string.

A valid provider name is preserved byte-for-byte. The direct verifier preflight does not
trim, rewrite, select, or query provider availability. Evidence collectors retain their
stronger `ensure_provider_available()` gate before invoking these direct verifiers.

This boundary intentionally runs before artifact work so malformed programmatic input
cannot trigger large 1B-class manifest/graph/external-data reads or incidental ORT
session construction before the configuration error is reported. Artifact integrity,
source identity, manifest validation, and provider/runtime failures remain separate
subsequent gates.
