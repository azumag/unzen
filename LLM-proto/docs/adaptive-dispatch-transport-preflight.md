# Adaptive dispatch transport preflight

`AdaptiveChunkDispatcher` separates transport validation from transport-history commit so a knowably invalid target cannot leave partial simulated network state.

At construction time, the immutable Coordinator target is checked against the selected `AllowlistedPrototypeTransport`. The legacy CDN target is also checked when no `ArtifactResidencyLedger` is present. When a manifest-backed ledger supplies explicit artifact/component locators, the configured legacy `cdnUrl` is not authoritative and is therefore not required to be allowlisted.

For each assignment, the dispatcher builds the exact connection set it is about to use: the Coordinator assignment URL plus either every missing manifest component locator or the legacy segment URLs. It calls the transport's side-effect-free `assertConnectable()` for the complete set first. Only when every target passes does it append the same URLs through `connect()` in the existing order and then commit worker/ledger residency.

This makes the assignment boundary fail-closed in two dimensions:

- a rejected later component does not leave the Coordinator or earlier components in transport history;
- cache residency remains uncommitted until all connection targets for that assignment have passed the allowlist contract.

The change does not expand the network allowlist, rewrite artifact locators, alter worker scoring/chunk selection, or add fallback networking. Valid legacy and manifest-backed connection reports retain their previous ordering.

This is coordinator-side simulated dispatch reliability coverage under #167. It is not evidence of real Llama-3.2-1B q4 browser execution, physical GPU memory usage, real multi-browser relay latency, or worker-loss recovery on real hardware.
