# Endpoint embedding artifact-policy exact arithmetic

The endpoint embedding artifact-policy verifier treats row geometry, artifact spans, tile spans, source offsets, and physical-artifact totals as exact non-negative integers.

Arithmetic is therefore fail-closed before JavaScript can perform an operation outside the safe-integer range:

- initializer and tile end offsets use a pre-add guard;
- row-to-byte and tile-to-byte geometry use staged pre-multiply guards;
- expected and actual tile source offsets are guarded before addition;
- aggregate physical-artifact bytes are guarded before each addition.

Existing policy ceilings, violation codes, the pinned 4-artifact / 8-tile geometry, and the verifier's `diagnostic-only` decision status are unchanged. These guards strengthen contract integrity only; they are not new physical WebGPU or runtime evidence for #167.
