# Reserved evidence output cleanup policy

Status: **host-side evidence reliability policy decision (unzen#1494)**. This document records which cleanup contract the shared `tools/evidence_output_reservation.mjs` helper implements. It is not new real-model, physical WebGPU, relay/latency, worker-loss/resume, or cache-residency evidence, and it promotes no readiness level.

## Decision

Of the four candidate directions recorded in #1494, the adopted policy is:

- **primary: candidate 2 — generation-bound cleanup with an explicit capability gate.** An uncommitted reservation is removed only after the removal has been bound to the reserved inode generation, and only when the runtime exposes the primitives that sequence needs;
- **fallback: candidate 4 — fail closed when the primitive is unavailable.** If the generation-bound sequence cannot be expressed, cleanup performs no filesystem mutation at all, reports `false`, and leaves the failed reservation artifact in place for the operator;
- **candidate 1 — descriptor-relative `unlinkat(dirFd, name)` — is unavailable.** Node's standard `fs` API exposes no descriptor-relative removal primitive on macOS or Linux, so there is no kernel-side binding to use;
- **candidate 3 — keep the pathname unlink and document the hazard — is rejected.** It leaves the shared output pathname itself as the delete target, so any concurrent writer of the evidence directory (not only a same-user actor racing a private name) can have an unrelated file removed by cleanup.

## Cleanup sequence

`cleanupReservedEvidenceOutput(outputFd, outputPath, outputCommitted)` performs, in order:

1. `outputCommitted === true` → return `false` without touching the filesystem. Committed evidence is never removed.
2. the pathname must still identify the reserved device/inode (`fstat` on the reserved descriptor vs `lstat` on the pathname) → otherwise return `false`. A pathname that already holds another file is left completely untouched.
3. `evidenceOutputGenerationBoundCleanupAvailable()` must report the removal primitives as available → otherwise return `false` (the candidate 4 fallback).
4. rename the validated pathname to a private sibling name (`.unzen-reservation-cleanup-<uuid>`), i.e. a name created by this helper with an unpredictable suffix, so no unrelated file can already occupy it.
5. re-verify the device/inode generation **at the private name**. If the quarantined entry is not the reservation, a replacement landed in the check→removal window: it is restored to the original pathname and the call returns `false`.
6. `unlink` the private name. Only the reserved generation reaches this point, and only under a name that was never announced. Return `true` only after the removal succeeded.

A contained failure at step 4 or 6 restores the reservation to its original pathname where that is still possible (the destination must be free again), so a failed cleanup leaves the pre-cleanup state observable rather than silently dropping or displacing the artifact.

## What this guarantees

- committed output is never removed;
- the reserved output pathname is never the delete target: a pathname that already holds a replacement is neither deleted nor left renamed (the end state is the pre-cleanup state), and a replacement injected between the step-2 pathname identity check and the removal is quarantined, detected at the private name, and restored byte-for-byte;
- an unchanged failed reservation is still removed, and cleanup reports success only after the unlink actually succeeded;
- when the generation-bound primitives are unavailable, nothing is mutated and `false` is reported;
- endpoint embedding and post-stage RSS callers keep one shared policy: every `tools/capture_endpoint*.mjs` routes cleanup through this helper and performs no reservation removal of its own.

## Residual boundary

The reserved output pathname is never the delete target, but the **private quarantine name is**. It becomes visible in `readdir` the moment the rename lands, so a same-user process watching the output directory can overwrite that name in the remaining window before its unlink; the removal then reports success while removing an unrelated file. An out-of-tree probe (3000 tight-loop trials against a directory watcher) hit the quarantine name in ~72% of trials, so this window is reachable rather than theoretical: closing it completely requires `unlinkat`, which Node does not expose, and the only alternative is to stop auto-removing reservations altogether (candidate 4), which the capability gate applies when the primitives are missing.

Restoring a quarantined entry has the same shape: it renames the entry back only after observing that the original pathname is free again, so an actor that re-creates that pathname inside the restore check→rename window can have its file overwritten. Both windows require same-user write access to the output directory while cleanup runs, and both are documented here rather than claimed away.

Parent-directory mtime gating was considered as the generation token and rejected: evidence output directories are shared, so any sibling file created during a capture would refuse legitimate cleanup of an unchanged reservation.

## Regression coverage

- `tests/evidence-output-reservation-generation-bound.test.ts` — capability probe, unchanged-reservation removal, committed-evidence protection, pre-existing replacement, missing pathname, single-shared-policy source scan over every host-side capture tool.
- `tests/evidence-output-reservation-race-quarantine.test.ts` — private-name removal boundary, and a deterministic replacement injected between the step-2 pathname identity check and the quarantine rename (i.e. before the final re-verification), plus committed evidence and already-retargeted pathnames mutating nothing.
- `tests/evidence-output-reservation-capability-gate.test.ts` — the fallback when the removal primitives are unavailable.
- `tests/evidence-output-reservation-unlink-failure.test.ts` — a contained unlink failure is never reported as a successful cleanup.
- `tests/endpoint-embedding-webgpu-output-reservation.test.ts`, `tests/endpoint-poststage-webgpu-process-rss-output-reservation.test.ts`, `tests/eight-physical-rss-bound-output-reservation.test.ts`, `tests/eight-physical-rss-direct-output-reservation.test.ts` — the capture-side reserve/commit/cleanup ordering contract.

Related: #1490, #1491, #1492, #1493, #1495, #1496, #167.
