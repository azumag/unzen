import { randomUUID } from 'node:crypto';
import { fstatSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Shared reservation contract for host-side evidence output files.
 *
 * Policy decision recorded by unzen#1494: generation-bound cleanup (candidate 2) with the
 * candidate 4 fail-closed fallback. This helper is the single place that decides how a still
 * uncommitted evidence-output reservation may be removed, and every host-side capture tool routes
 * its cleanup through it.
 *
 * Contract:
 *   reserve  - create the output path exclusively (`wx`, mode `0600`), so a pre-existing
 *              destination is rejected instead of overwritten, before any profile/browser side
 *              effect is started;
 *   commit   - write the JSON through the reserved descriptor, `fsync` it, re-check that the
 *              pathname still identifies the reserved device/inode generation, then mark the
 *              output committed;
 *   cleanup  - only for an uncommitted reservation, and only by binding the removal to the
 *              reserved inode generation: the validated pathname is first renamed to a private,
 *              unpredictable sibling name, the device/inode generation is re-verified at that
 *              private name, and only then is that name unlinked.
 *
 * Why the quarantine rename (and not a plain `unlinkSync(outputPath)`): the identity check and a
 * pathname unlink are separate syscalls, so a rename/replacement that lands between them makes
 * the unlink delete whatever now occupies the pathname. There is no way to close that window with
 * a pathname-based unlink, so the removal is performed against a name we just created ourselves.
 * Candidate 1 (`unlinkat(dirFd, name)`) is unavailable: Node's standard `fs` API exposes no
 * descriptor-relative removal primitive on macOS or Linux, so there is no kernel-side binding to
 * use. Parent-directory mtime gating was rejected as the generation token because evidence output
 * directories are shared, so any sibling file created during a capture would refuse legitimate
 * cleanup of an unchanged reservation.
 *
 * Fallback: when the runtime does not expose the primitives the sequence needs, cleanup performs
 * no filesystem mutation at all and reports `false`, leaving the failed reservation artifact in
 * place for the caller/operator to inspect instead of risking deletion of a replacement.
 *
 * Residual boundary (documented, not claimed away): the reserved output pathname is never the
 * delete target, but the private quarantine name is. A same-user process that watches the output
 * directory can see that name in `readdir` as soon as the rename lands and overwrite it in the
 * remaining window before its unlink, which would remove an unrelated file while reporting success.
 * The restore step has the same shape: it renames back only after observing the original pathname
 * free, so a file re-created in that window can be overwritten. Both windows require same-user
 * write access to the output directory while cleanup runs, and closing them completely requires
 * `unlinkat`, which Node does not expose; the alternative is to stop auto-removing reservations
 * entirely (candidate 4), which the capability gate applies when the primitives are missing.
 */

// Primitives the generation-bound cleanup sequence needs. Captured as values so the capability
// probe reports exactly what the loaded `node:fs` module exposes to this helper.
const GENERATION_BOUND_CLEANUP_PRIMITIVES = [renameSync, unlinkSync];

/** True when the runtime exposes every primitive the generation-bound cleanup sequence requires. */
export function evidenceOutputGenerationBoundCleanupAvailable() {
  return GENERATION_BOUND_CLEANUP_PRIMITIVES.every((primitive) => typeof primitive === 'function');
}

export function reserveEvidenceOutput(outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  return openSync(outputPath, 'wx', 0o600);
}

function evidenceOutputPathMatchesFd(outputFd, candidatePath) {
  let fdStat;
  let pathStat;
  try {
    fdStat = fstatSync(outputFd, { bigint: true });
    pathStat = lstatSync(candidatePath, { bigint: true });
  } catch {
    return false;
  }
  return fdStat.isFile()
    && pathStat.isFile()
    && fdStat.dev === pathStat.dev
    && fdStat.ino === pathStat.ino;
}

export function assertEvidenceOutputPathIdentity(outputFd, outputPath) {
  if (!evidenceOutputPathMatchesFd(outputFd, outputPath)) {
    throw new Error('evidence output path identity changed after reservation');
  }
}

// Private sibling name used to quarantine a reservation before it is removed. The random suffix
// keeps the name unpredictable, so no unrelated file can already be sitting on it, and the
// `.unzen-reservation-cleanup-` prefix makes a leftover artifact self-identifying.
function evidenceOutputCleanupQuarantinePath(outputPath) {
  return join(dirname(outputPath), `.unzen-reservation-cleanup-${randomUUID()}`);
}

// Best-effort restoration of a quarantined pathname to its original location. Used when the
// quarantined entry turned out not to be the reserved inode (so the reserved pathname had already
// been retargeted) and when the unlink itself failed; in both cases the observable end state is
// the pre-cleanup state, and `false` reports that nothing was removed. Failures here are ignored:
// the caller only needs to know that no removal succeeded.
function restoreQuarantinedReservation(quarantinePath, outputPath) {
  try {
    lstatSync(outputPath);
    // The reserved pathname is occupied again; keep the quarantined artifact rather than clobber
    // whatever is there now.
    return;
  } catch {
    try {
      renameSync(quarantinePath, outputPath);
    } catch {
      // Nothing further can be done here; the artifact stays under its marked quarantine name.
    }
  }
}

export function cleanupReservedEvidenceOutput(outputFd, outputPath, outputCommitted) {
  // Committed evidence is never removed, whatever the pathname now holds.
  if (outputCommitted) return false;
  // A pathname that no longer identifies the reserved inode is somebody else's file: leave it.
  if (!evidenceOutputPathMatchesFd(outputFd, outputPath)) return false;
  // Candidate 4 fallback: without the primitives for a generation-bound removal, mutate nothing.
  if (!evidenceOutputGenerationBoundCleanupAvailable()) return false;

  // Bind the removal to the reserved inode generation: move the validated pathname to a private
  // name we create ourselves, so a replacement landing between the check above and this rename is
  // moved aside (and then restored below) instead of being deleted.
  const quarantinePath = evidenceOutputCleanupQuarantinePath(outputPath);
  try {
    renameSync(outputPath, quarantinePath);
  } catch {
    return false;
  }

  if (!evidenceOutputPathMatchesFd(outputFd, quarantinePath)) {
    // The entry we quarantined is not the reservation: restore it untouched and fail closed.
    restoreQuarantinedReservation(quarantinePath, outputPath);
    return false;
  }

  try {
    // The private name was verified to hold the reserved generation; delete only that name.
    unlinkSync(quarantinePath);
    return true;
  } catch {
    // A contained unlink failure must not be reported as a successful cleanup.
    restoreQuarantinedReservation(quarantinePath, outputPath);
    return false;
  }
}
