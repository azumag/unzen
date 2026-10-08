# Reserved evidence output cleanup policy

Status: **host-side evidence reliability policy decision (unzen#1494)**. This document records the shared `tools/evidence_output_reservation.mjs` contract. It promotes no real-model, physical WebGPU, relay/latency, worker-loss/resume, cache-residency, or production readiness claim.

## Decision

The adopted policy is **candidate 4: skip automatic cleanup when generation-bound removal cannot be guaranteed**. On the supported Node runtimes, `cleanupReservedEvidenceOutput()` performs no filesystem operation and always returns `false`. `evidenceOutputGenerationBoundCleanupAvailable()` always returns `false`: ordinary rename/unlink functions do not supply the required guarantee.

This supersedes PR #1679's earlier candidate-2 quarantine sequence. Independent review [5450591171](https://github.com/azumag/unzen/pull/1679#pullrequestreview-5450591171) identified that replacing the quarantine entry after the final inode check but before pathname unlink still deletes an unrelated file. A check followed by restoration rename also allows an unrelated destination to be overwritten. Removing only unlink while retaining quarantine/restore would still move or overwrite files, so the entire sequence is removed.

Candidate 3 (best-effort pathname deletion with a documented hazard) is rejected. Candidate 1's descriptor-relative `unlinkat(dirFd, name)` is not exposed by Node's standard `fs` API; moreover, anchoring the parent directory alone would not atomically compare the final entry with the reserved inode. Candidate 2 may only be reconsidered with a backend that actually guarantees removal of the reserved generation and deterministic coverage of replacement after the final check. Merely detecting function names cannot enable it.

## Cleanup contract and retry

`cleanupReservedEvidenceOutput(outputFd, outputPath, outputCommitted)` returns `false` before inspecting or mutating the namespace, for committed, uncommitted, replaced, missing, and closed-descriptor inputs alike. It never renames, quarantines, restores, unlinks, truncates, or writes a file. `false` means no removal succeeded; it does not mean the pathname is available for reuse. Callers still close their descriptors afterward.

An unchanged failed reservation remains at the requested output pathname with its original contents, which may be empty or partially written. It is a failed diagnostic artifact, **not committed or verified evidence**. The helper adds no failure marker and does not move it to a marked filename, because that would itself mutate the namespace. If another process has moved or replaced the reservation, cleanup leaves every current entry untouched.

Reservation remains exclusive (`wx`, mode `0600`). To retry:

- choose a different output pathname; or
- after capture has stopped, inspect the failed artifact and manually remove it before reusing the same pathname.

Reusing an occupied pathname without that manual step fails with `EEXIST`; cleanup never performs that step automatically. Bound captures may leave more than one failed reservation (for example the copied RSS output and its bound sidecar); each destination must be handled separately. For cancellation capture, the raw output reservation belongs to the direct child capture, which also uses the shared helper; the wrapper owns the bound sidecar reservation.

## Guarantees and limits

- Cleanup does not delete, rename, or overwrite committed evidence, unchanged failed reservations, replacements, or unrelated siblings.
- There is no final-check-to-rename, final-check-to-unlink, or restore window in cleanup, because none of those operations is attempted.
- All host-side `tools/capture_endpoint*.mjs` callers retain one shared cleanup policy and close their reserved descriptors.
- Exclusive reservation and descriptor-bound publication/identity checks are unchanged. This decision does not establish adversarial namespace isolation for capture publication or output/input alias preflight, nor does it automatically identify failed artifacts as valid evidence.

The [Node filesystem API](https://nodejs.org/docs/latest-v22.x/api/fs.html) exposes pathname-based rename and unlink, not removal conditional on an expected inode generation. The conservative fallback therefore remains active even when both functions exist.

## Regression coverage

- `tests/evidence-output-reservation-generation-bound.test.ts`: unavailable capability on ordinary Node, retained failures, committed/replaced/missing/closed-descriptor cases, retry by alternate name or fixture-only manual removal, and the shared policy across capture callers.
- `tests/evidence-output-reservation-race-quarantine.test.ts`: records filesystem mutation calls and compares directory names, device/inode identities, and bytes. Replacement hooks at the old pre-rename and final-quarantine-check-to-unlink boundaries stay unreachable. Existing replacement and unrelated/private-name siblings remain untouched.
- `tests/evidence-output-reservation-capability-gate.test.ts`: no mutation when pathname removal functions are absent.
- `tests/evidence-output-reservation-unlink-failure.test.ts`: a throwing unlink primitive is never called and no removal success is reported.
- Endpoint embedding, post-stage RSS, direct RSS, and bound RSS reservation tests: capture-side reserve/commit/cleanup ordering and retention of failed output.

Related: #1490, #1491, #1492, #1493, #1495, #1496, #167.
