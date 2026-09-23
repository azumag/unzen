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

function normalizeOutputEntries(outputEntries) {
  if (!Array.isArray(outputEntries) || outputEntries.length === 0) {
    throw new Error('outputEntries must contain at least one cancellation RSS output');
  }
  return outputEntries.map((entry) => {
    if (
      !entry
      || typeof entry !== 'object'
      || typeof entry.label !== 'string'
      || entry.label.trim() === ''
      || typeof entry.path !== 'string'
      || entry.path.trim() === ''
    ) {
      throw new Error('each cancellation RSS output entry must have a non-empty label and path');
    }
    const path = resolve(entry.path);
    const pathSnapshot = existingPathSnapshot(path);
    if (pathSnapshot?.isSymbolicLink()) {
      throw new Error(`${entry.label} must not be an existing symlink`);
    }
    return {
      label: entry.label,
      path,
      canonicalDestination: canonicalOutputDestination(path),
      targetSnapshot: pathSnapshot === null ? null : existingTargetSnapshot(path),
    };
  });
}

function assertOutputsDoNotAliasEachOther(outputs) {
  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index];
    for (let earlierIndex = 0; earlierIndex < index; earlierIndex += 1) {
      const earlier = outputs[earlierIndex];
      if (
        output.path === earlier.path
        || (
          output.canonicalDestination !== null
          && earlier.canonicalDestination !== null
          && output.canonicalDestination === earlier.canonicalDestination
        )
        || (
          output.targetSnapshot !== null
          && earlier.targetSnapshot !== null
          && sameFileIdentity(output.targetSnapshot, earlier.targetSnapshot)
        )
      ) {
        throw new Error(`${output.label} must not alias output ${earlier.label}`);
      }
    }
  }
}

export function assertCancellationRssOutputPathsDoNotAliasInputs(
  config,
  preflightReport,
  outputEntries,
) {
  const outputs = normalizeOutputEntries(outputEntries);
  assertOutputsDoNotAliasEachOther(outputs);

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

  for (const output of outputs) {
    const inputLabel = inputPaths.get(output.path);
    if (inputLabel) {
      throw new Error(`${output.label} must not alias validated input ${inputLabel}`);
    }

    for (const input of inputFilesystemIdentities) {
      if (
        output.canonicalDestination !== null
        && input.realPath !== null
        && output.canonicalDestination === input.realPath
      ) {
        throw new Error(`${output.label} must not alias validated input ${input.label}`);
      }
      if (
        output.targetSnapshot !== null
        && input.stat !== null
        && sameFileIdentity(output.targetSnapshot, input.stat)
      ) {
        throw new Error(`${output.label} must not alias validated input ${input.label}`);
      }
    }
  }
}
