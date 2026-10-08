import { fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Shared reservation contract for host-side evidence output files (unzen#1494).
 *
 * reserve: create exclusively (`wx`, mode `0600`) before capture side effects.
 * commit: callers write through the reserved descriptor, fsync, verify the pathname's
 * device/inode identity, and only then mark the output committed.
 * cleanup: candidate 4, fail closed without any filesystem operation. Node's standard
 * fs API has no removal operation atomically conditional on the reserved inode generation.
 * A check followed by pathname rename/unlink still allows replacement after the final check;
 * quarantine and restoration also risk moving or overwriting somebody else's file.
 *
 * Failed reservations therefore remain at their current pathname, possibly empty or partially
 * written. They are not committed evidence. Retry with a different output name, or have the
 * operator inspect and manually remove the failed artifact before reusing the same name.
 * Callers still close their descriptors after cleanup. See the shared cleanup policy doc.
 */

/** Whether this helper has a backend that can actually guarantee generation-bound removal. */
export function evidenceOutputGenerationBoundCleanupAvailable() {
  // The presence of rename/unlink functions is not that guarantee. No supported backend exists.
  return false;
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

export function cleanupReservedEvidenceOutput(_outputFd, _outputPath, _outputCommitted) {
  // Fail before even inspecting the namespace: no rename, quarantine, restore, unlink, or write.
  // false means no removal succeeded, including for an unchanged failed reservation.
  return false;
}
