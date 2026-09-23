import { fstatSync, lstatSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export function reserveEvidenceOutput(outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  return openSync(outputPath, 'wx', 0o600);
}

function evidenceOutputPathMatchesFd(outputFd, outputPath) {
  let fdStat;
  let pathStat;
  try {
    fdStat = fstatSync(outputFd, { bigint: true });
    pathStat = lstatSync(outputPath, { bigint: true });
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

export function cleanupReservedEvidenceOutput(outputFd, outputPath, outputCommitted) {
  if (outputCommitted || !evidenceOutputPathMatchesFd(outputFd, outputPath)) return false;
  try {
    unlinkSync(outputPath);
    return true;
  } catch {
    return false;
  }
}
