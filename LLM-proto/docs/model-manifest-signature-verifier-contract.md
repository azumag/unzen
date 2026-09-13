# Model manifest signature verifier result contract

A model-manifest signature verifier succeeds only when it resolves to the exact boolean `true`. `false` and all non-boolean runtime values are treated as verification failure even when JavaScript would consider them truthy.

This keeps the external verifier callback fail-closed across asserted or dynamically implemented runtime boundaries without changing the signed payload, unsigned-manifest behavior, or verifier exception behavior.

This is signature trust-boundary hardening only. It is not new real Llama-3.2-1B q4 artifact, physical WebGPU, multi-browser relay/latency, or worker-loss evidence for #167.
