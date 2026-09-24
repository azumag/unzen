# WebGPU two-browser split harness

Browser query parsing is centralized in `browser-runtime-config.js`. Both `runner-bootstrap.js` and `runner-v3.js` read the same resolved runtime configuration so preflight and execution cannot drift on omitted-query defaults or numeric parsing.

Current shared defaults are:

- worker role: `segment0` (owned by `runtime-validation.js` as `DEFAULT_BROWSER_WORKER_ROLE`);
- run ID: the canonical browser default from `run-id.js`;
- checkpoint wait: the canonical timeout from `checkpoint-wait-config.js`;
- model: `onnx-community/Llama-3.2-1B-Instruct`;
- split root: `/models`;
- KV heads: `8`;
- head size: `64`;
- artifact budget mode: `absolute`.

The browser worker registration contract remains defined in `runtime-validation.js`: explicit roles are limited to `segment0`, `segment1`, and `standby`, and explicit worker IDs retain the Coordinator-compatible syntax. When `worker` is omitted, `runner-v3.js` still generates an ID prefixed with the resolved role.

`browser-runtime-config.js` only resolves query values. Validation remains fail-closed in bootstrap before external runtime loading, with execution-side defenses kept where they already exist. Coordinator trust checks remain authoritative for registration and run evidence.

## Resume evidence contract

Result payloads use an explicit boolean `resumedFromCheckpoint` field. The browser runner emits `false` for the primary `segment1` role and `true` for `standby`. The Coordinator requires an actual JSON boolean, binds it to the authenticated registered worker role before mutating result state, and includes the exact value in the immutable result digest. A primary result claiming resume or a standby result denying resume is rejected as `result-resume-role-mismatch`; missing or coercible values are rejected as malformed result payloads.

This field is evidence metadata only. Synthetic Coordinator coverage does not by itself prove physical worker-loss/resume behavior; that still requires the distinct-browser runtime evidence tracked by issue #167.
