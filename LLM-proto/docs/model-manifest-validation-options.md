# Model manifest validation option ownership

Model-manifest validation treats its options as a runtime trust boundary. Supplied option containers and fields are validated before manifest field access, and caller-owned policy arrays are copied into frozen snapshots.

Async full validation captures `verifySignature` at entry. Replacing or removing the caller's verifier while digest work is in flight therefore cannot change the trust callback used for the signature gate.

Explicit empty `supportedSchemaVersions` or `allowedSources` arrays retain their existing deny-all semantics; omitted fields retain the existing defaults.

This is validation-policy ownership hardening only. It is not new real Llama-3.2-1B q4 artifact, physical WebGPU, multi-browser relay/latency, or worker-loss evidence for #167.
