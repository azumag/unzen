# Artifact residency array runtime boundary

`ArtifactResidencyLedger` accepts three caller-owned arrays at runtime: constructor artifacts, compatibility `SegmentConfig` values, and heartbeat/cache `segmentIndexes`. TypeScript types do not make those containers trustworthy; JavaScript callers can supply proxies whose array checks, `length` access, or numeric property reads throw.

The ledger therefore establishes an owned top-level membership snapshot before it reads nested artifact/config fields or mutates worker residency. Each boundary:

- bounds `Array.isArray()` so revoked proxies map to the existing non-array diagnostic;
- reads `length` once and maps a throwing or invalid length to a ledger-owned diagnostic;
- copies each position by numeric index exactly once, without invoking `Symbol.iterator`;
- maps throwing indexed reads to deterministic ledger-owned diagnostics without inspecting or stringifying the thrown value.

The compatibility `SegmentConfig` boundary has an additional semantic bound that already follows from the ledger contract: the readable caller-owned array length must equal the ledger's artifact count. That equality is checked immediately after the single bounded `length` read and before any numeric index access. A readable mismatch therefore keeps the existing `segment config count N does not match artifact count M` diagnostic without walking caller-controlled positions, while correctly-sized arrays retain the same numeric-index read-once snapshot behavior.

Nested artifact/config validation continues only after this capture succeeds. In `synchronizeWorker()`, the complete captured list is validated before `residentByWorker` is changed, so a rejected proxy, invalid index, or unknown segment leaves the prior worker residency snapshot intact.

This is a runtime reliability boundary only. It does not constitute new evidence for model execution, WebGPU capability, browser-to-browser relay, worker-loss recovery, or measured cache residency behavior.
