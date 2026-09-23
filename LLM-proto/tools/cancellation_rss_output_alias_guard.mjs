import {
  lstatSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

function missingPath(error) {
  return error && typeof error === 'object'
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function existingPathSnapshot(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (missingPath(error)) return null;
    throw error;
  }
}

function existingTargetSnapshot(path) {
  try {
    return statSync(path, { bigint: true });
  } catch (error) {
    if (missingPath(error)) return null;
    throw error;
  }
}

function existingRealPath(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (missingPath(error)) return null;
    throw error;
  }
}

function canonicalOutputDestination(path) {
  const parent = existingRealPath(dirname(path));
  return parent === null ? null : resolve(parent, basename(path));
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function assertCancellationRssOutputPathsDoNotAliasInputs(
  config,
  preflightReport,
  outputEntries,
) {
  if (!Array.isArray(outputEntries) || outputEntries.length === 0) {
    throw new Error('outputEntries must contain at least one cancellation RSS output');
  }

  const inputEntries = [
    { path: resolve(config.preflightReport), label: 'PREFLIGHT_REPORT' },
    { path: resolve(config.graphPath), label: 'GRAPH_PATH' },
  ];
  for (let index = 0; index < preflightReport.payloads.length; index += 1) {
    const payload = preflightReport.payloads[index];
    inputEntries.push({
      path: resolve(config.dataDir, payload.file),
      label: `preflight.payloads[${index}]`,
    });
  }

  const inputPaths = new Map(inputEntries.map((entry) => [entry.path, entry.label]));
  const inputFilesystemIdentities = inputEntries.map((entry) => ({
    ...entry,
    realPath: existingRealPath(entry.path),
    stat: existingTargetSnapshot(entry.path),
  }));

  for (const entry of outputEntries) {
    if (!entry || typeof entry !== 'object' || typeof entry.label !== 'string' || !entry.label) {
      throw new Error('each cancellation RSS output entry must have a non-empty label');
    }
    const resolvedOutputPath = resolve(entry.path);
    const inputLabel = inputPaths.get(resolvedOutputPath);
    if (inputLabel) {
      throw new Error(`${entry.label} must not alias validated input ${inputLabel}`);
    }

    const outputPathSnapshot = existingPathSnapshot(resolvedOutputPath);
    if (outputPathSnapshot?.isSymbolicLink()) {
      throw new Error(`${entry.label} must not be an existing symlink`);
    }

    const canonicalDestination = canonicalOutputDestination(resolvedOutputPath);
    const outputTargetSnapshot = outputPathSnapshot === null
      ? null
      : existingTargetSnapshot(resolvedOutputPath);
    for (const input of inputFilesystemIdentities) {
      if (
        canonicalDestination !== null
        && input.realPath !== null
        && canonicalDestination === input.realPath
      ) {
        throw new Error(`${entry.label} must not alias validated input ${input.label}`);
      }
      if (
        outputTargetSnapshot !== null
        && input.stat !== null
        && sameFileIdentity(outputTargetSnapshot, input.stat)
      ) {
        throw new Error(`${entry.label} must not alias validated input ${input.label}`);
      }
    }
  }
}
