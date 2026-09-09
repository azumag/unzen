#!/usr/bin/env node
/** Verify #167 artifact-policy and byte-geometry invariants for the pinned endpoint embedding candidate. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDPOINT_EMBEDDING_WEBGPU_EXPECTED } from '../browser-harness/endpoint-embedding-tiled-webgpu/contract.js';

const FLOAT32_BYTES = 4;
const MIB = 1024 * 1024;

export const ENDPOINT_EMBEDDING_ARTIFACT_POLICY = Object.freeze({
  targetBytes: 200 * MIB,
  preferredCeilingBytes: 256 * MIB,
  normalCeilingBytes: 512 * MIB,
  hardCeilingBytes: 1024 * MIB,
});

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireSafeInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) {
    throw new Error(`${label} must be a ${positive ? 'positive' : 'non-negative'} safe integer`);
  }
  return value;
}

function tierForBytes(bytes) {
  if (bytes <= ENDPOINT_EMBEDDING_ARTIFACT_POLICY.preferredCeilingBytes) return 'preferred';
  if (bytes <= ENDPOINT_EMBEDDING_ARTIFACT_POLICY.normalCeilingBytes) return 'normal';
  if (bytes <= ENDPOINT_EMBEDDING_ARTIFACT_POLICY.hardCeilingBytes) return 'degraded-exceptional';
  return 'reject';
}

function violation(violations, code, detail) {
  violations.push({ code, detail });
}

export function evaluateEndpointEmbeddingArtifactPolicyContract(contract = ENDPOINT_EMBEDDING_WEBGPU_EXPECTED) {
  requireObject(contract, 'endpoint embedding contract');
  const violations = [];

  const rows = requireSafeInteger(contract.rows, 'rows', { positive: true });
  const hiddenSize = requireSafeInteger(contract.hiddenSize, 'hiddenSize', { positive: true });
  const initializer = requireObject(contract.embeddingInitializer, 'embeddingInitializer');
  const initializerOffset = requireSafeInteger(
    initializer.sourceOffsetBytes,
    'embeddingInitializer.sourceOffsetBytes',
  );
  const initializerBytes = requireSafeInteger(
    initializer.byteLength,
    'embeddingInitializer.byteLength',
    { positive: true },
  );
  const initializerEnd = initializerOffset + initializerBytes;
  if (!Number.isSafeInteger(initializerEnd)) {
    throw new Error('embedding initializer end offset exceeds safe integer range');
  }

  const expectedInitializerBytes = rows * hiddenSize * FLOAT32_BYTES;
  if (!Number.isSafeInteger(expectedInitializerBytes)) {
    throw new Error('embedding row geometry exceeds safe integer range');
  }
  if (initializerBytes !== expectedInitializerBytes) {
    violation(
      violations,
      'embedding-initializer-byte-geometry',
      `initializer byteLength ${initializerBytes} != rows*hiddenSize*4 ${expectedInitializerBytes}`,
    );
  }

  if (!Array.isArray(contract.physicalArtifacts) || contract.physicalArtifacts.length === 0) {
    throw new Error('physicalArtifacts must be a non-empty array');
  }
  if (!Array.isArray(contract.tiles) || contract.tiles.length === 0) {
    throw new Error('tiles must be a non-empty array');
  }

  const physicalArtifactCount = requireSafeInteger(
    contract.physicalArtifactCount,
    'physicalArtifactCount',
    { positive: true },
  );
  const executionTileCount = requireSafeInteger(
    contract.executionTileCount,
    'executionTileCount',
    { positive: true },
  );
  if (physicalArtifactCount !== contract.physicalArtifacts.length) {
    violation(
      violations,
      'physical-artifact-count',
      `physicalArtifactCount ${physicalArtifactCount} != array length ${contract.physicalArtifacts.length}`,
    );
  }
  if (executionTileCount !== contract.tiles.length) {
    violation(
      violations,
      'execution-tile-count',
      `executionTileCount ${executionTileCount} != array length ${contract.tiles.length}`,
    );
  }

  const artifactByIndex = new Map();
  const physicalArtifacts = contract.physicalArtifacts.map((artifact, arrayIndex) => {
    requireObject(artifact, `physicalArtifacts[${arrayIndex}]`);
    const index = requireSafeInteger(artifact.index, `physicalArtifacts[${arrayIndex}].index`);
    const bytes = requireSafeInteger(artifact.bytes, `physicalArtifacts[${arrayIndex}].bytes`, { positive: true });
    const sourceOffsetBytes = requireSafeInteger(
      artifact.sourceOffsetBytes,
      `physicalArtifacts[${arrayIndex}].sourceOffsetBytes`,
    );
    const sourceEndOffsetBytesExclusive = requireSafeInteger(
      artifact.sourceEndOffsetBytesExclusive,
      `physicalArtifacts[${arrayIndex}].sourceEndOffsetBytesExclusive`,
      { positive: true },
    );
    if (artifactByIndex.has(index)) {
      violation(violations, 'duplicate-physical-artifact-index', `physical artifact index ${index} is duplicated`);
    }
    if (index !== arrayIndex) {
      violation(
        violations,
        'physical-artifact-index-order',
        `physicalArtifacts[${arrayIndex}].index is ${index}`,
      );
    }
    if (sourceEndOffsetBytesExclusive - sourceOffsetBytes !== bytes) {
      violation(
        violations,
        'physical-artifact-byte-span',
        `artifact ${index} source span does not equal bytes`,
      );
    }
    const tier = tierForBytes(bytes);
    if (tier === 'reject') {
      violation(
        violations,
        'physical-artifact-hard-ceiling',
        `artifact ${index} is ${bytes} bytes, above hard ceiling ${ENDPOINT_EMBEDDING_ARTIFACT_POLICY.hardCeilingBytes}`,
      );
    }
    if (tier !== 'preferred') {
      violation(
        violations,
        'physical-artifact-preferred-ceiling',
        `pinned preferred-layout artifact ${index} is ${bytes} bytes (${tier}), above preferred ceiling ${ENDPOINT_EMBEDDING_ARTIFACT_POLICY.preferredCeilingBytes}`,
      );
    }
    const analysis = {
      index,
      bytes,
      sourceOffsetBytes,
      sourceEndOffsetBytesExclusive,
      tier,
      preferredHeadroomBytes: ENDPOINT_EMBEDDING_ARTIFACT_POLICY.preferredCeilingBytes - bytes,
      hardHeadroomBytes: ENDPOINT_EMBEDDING_ARTIFACT_POLICY.hardCeilingBytes - bytes,
    };
    artifactByIndex.set(index, analysis);
    return analysis;
  });

  let sourceCursor = initializerOffset;
  for (const artifact of physicalArtifacts) {
    if (artifact.sourceOffsetBytes !== sourceCursor) {
      violation(
        violations,
        'physical-artifact-source-contiguity',
        `artifact ${artifact.index} starts at ${artifact.sourceOffsetBytes}, expected ${sourceCursor}`,
      );
    }
    sourceCursor = artifact.sourceEndOffsetBytesExclusive;
  }
  if (sourceCursor !== initializerEnd) {
    violation(
      violations,
      'physical-artifact-source-coverage',
      `physical artifacts end at ${sourceCursor}, expected initializer end ${initializerEnd}`,
    );
  }

  const rangesByArtifact = new Map(physicalArtifacts.map((artifact) => [artifact.index, []]));
  let rowCursor = 0;
  const executionTiles = contract.tiles.map((tile, arrayIndex) => {
    requireObject(tile, `tiles[${arrayIndex}]`);
    const tileIndex = requireSafeInteger(tile.tileIndex, `tiles[${arrayIndex}].tileIndex`);
    const startRow = requireSafeInteger(tile.startRow, `tiles[${arrayIndex}].startRow`);
    const endRowExclusive = requireSafeInteger(
      tile.endRowExclusive,
      `tiles[${arrayIndex}].endRowExclusive`,
      { positive: true },
    );
    const rowCount = requireSafeInteger(tile.rowCount, `tiles[${arrayIndex}].rowCount`, { positive: true });
    const physicalArtifactIndex = requireSafeInteger(
      tile.physicalArtifactIndex,
      `tiles[${arrayIndex}].physicalArtifactIndex`,
    );
    const artifactByteOffset = requireSafeInteger(
      tile.artifactByteOffset,
      `tiles[${arrayIndex}].artifactByteOffset`,
    );
    const byteLength = requireSafeInteger(tile.byteLength, `tiles[${arrayIndex}].byteLength`, { positive: true });

    if (tileIndex !== arrayIndex) {
      violation(violations, 'execution-tile-index-order', `tiles[${arrayIndex}].tileIndex is ${tileIndex}`);
    }
    if (startRow !== rowCursor) {
      violation(
        violations,
        'execution-tile-row-contiguity',
        `tile ${tileIndex} starts at row ${startRow}, expected ${rowCursor}`,
      );
    }
    if (endRowExclusive - startRow !== rowCount) {
      violation(
        violations,
        'execution-tile-row-count',
        `tile ${tileIndex} row span does not equal rowCount`,
      );
    }
    const expectedTileBytes = rowCount * hiddenSize * FLOAT32_BYTES;
    if (!Number.isSafeInteger(expectedTileBytes)) {
      throw new Error(`tile ${tileIndex} byte geometry exceeds safe integer range`);
    }
    if (byteLength !== expectedTileBytes) {
      violation(
        violations,
        'execution-tile-byte-geometry',
        `tile ${tileIndex} byteLength ${byteLength} != rowCount*hiddenSize*4 ${expectedTileBytes}`,
      );
    }

    const artifact = artifactByIndex.get(physicalArtifactIndex);
    const tileEndInArtifact = artifactByteOffset + byteLength;
    if (!Number.isSafeInteger(tileEndInArtifact)) {
      throw new Error(`tile ${tileIndex} artifact end exceeds safe integer range`);
    }
    if (!artifact) {
      violation(
        violations,
        'execution-tile-artifact-reference',
        `tile ${tileIndex} references missing physical artifact ${physicalArtifactIndex}`,
      );
    } else {
      if (tileEndInArtifact > artifact.bytes) {
        violation(
          violations,
          'execution-tile-artifact-bounds',
          `tile ${tileIndex} ends at ${tileEndInArtifact} within artifact ${physicalArtifactIndex} of ${artifact.bytes} bytes`,
        );
      }
      const expectedSourceOffset = initializerOffset + startRow * hiddenSize * FLOAT32_BYTES;
      const actualSourceOffset = artifact.sourceOffsetBytes + artifactByteOffset;
      if (actualSourceOffset !== expectedSourceOffset) {
        violation(
          violations,
          'execution-tile-source-mapping',
          `tile ${tileIndex} maps to source byte ${actualSourceOffset}, expected ${expectedSourceOffset}`,
        );
      }
      rangesByArtifact.get(physicalArtifactIndex)?.push({
        tileIndex,
        start: artifactByteOffset,
        end: tileEndInArtifact,
      });
    }

    if (!Array.isArray(tile.globalTokenIds)
      || tile.globalTokenIds.length !== 2
      || tile.globalTokenIds[0] !== startRow
      || tile.globalTokenIds[1] !== endRowExclusive - 1) {
      violation(
        violations,
        'execution-tile-global-token-boundary',
        `tile ${tileIndex} globalTokenIds do not match its row boundaries`,
      );
    }

    rowCursor = endRowExclusive;
    return {
      tileIndex,
      startRow,
      endRowExclusive,
      rowCount,
      physicalArtifactIndex,
      artifactByteOffset,
      byteLength,
      preferredBindingHeadroomBytes: ENDPOINT_EMBEDDING_ARTIFACT_POLICY.preferredCeilingBytes - byteLength,
    };
  });

  if (rowCursor !== rows) {
    violation(
      violations,
      'execution-tile-row-coverage',
      `execution tiles end at row ${rowCursor}, expected ${rows}`,
    );
  }

  for (const artifact of physicalArtifacts) {
    const ranges = (rangesByArtifact.get(artifact.index) ?? []).sort((left, right) => left.start - right.start);
    let artifactCursor = 0;
    for (const range of ranges) {
      if (range.start !== artifactCursor) {
        violation(
          violations,
          'execution-tile-artifact-contiguity',
          `artifact ${artifact.index} tile ${range.tileIndex} starts at ${range.start}, expected ${artifactCursor}`,
        );
      }
      artifactCursor = Math.max(artifactCursor, range.end);
    }
    if (artifactCursor !== artifact.bytes) {
      violation(
        violations,
        'execution-tile-artifact-coverage',
        `artifact ${artifact.index} tiles cover through ${artifactCursor}, expected ${artifact.bytes}`,
      );
    }
  }

  const maximumPhysicalArtifactBytes = Math.max(...physicalArtifacts.map((artifact) => artifact.bytes));
  const maximumExecutionTileBytes = Math.max(...executionTiles.map((tile) => tile.byteLength));
  const totalPhysicalArtifactBytes = physicalArtifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  if (totalPhysicalArtifactBytes !== initializerBytes) {
    violation(
      violations,
      'physical-artifact-total-bytes',
      `physical artifact bytes total ${totalPhysicalArtifactBytes}, expected initializer byteLength ${initializerBytes}`,
    );
  }

  return {
    status: violations.length === 0 ? 'pass' : 'fail',
    decisionStatus: 'diagnostic-only',
    kind: 'unzen-endpoint-embedding-artifact-policy-contract',
    schemaVersion: '1.0.0',
    policy: ENDPOINT_EMBEDDING_ARTIFACT_POLICY,
    rows,
    hiddenSize,
    initializerBytes,
    totalPhysicalArtifactBytes,
    physicalArtifactCount: physicalArtifacts.length,
    executionTileCount: executionTiles.length,
    maximumPhysicalArtifactBytes,
    maximumExecutionTileBytes,
    maximumPhysicalArtifactPreferredHeadroomBytes:
      ENDPOINT_EMBEDDING_ARTIFACT_POLICY.preferredCeilingBytes - maximumPhysicalArtifactBytes,
    maximumPhysicalArtifactHardHeadroomBytes:
      ENDPOINT_EMBEDDING_ARTIFACT_POLICY.hardCeilingBytes - maximumPhysicalArtifactBytes,
    physicalArtifacts,
    executionTiles,
    violations,
    conclusion: violations.length === 0
      ? 'The pinned endpoint embedding candidate exactly covers the tied embedding initializer with contiguous preferred-budget physical artifacts and contiguous execution tiles whose source-byte mapping is internally consistent. This is a contract/policy diagnostic only and does not approve the 4-artifact/8-tile layout for production.'
      : 'The endpoint embedding candidate violates at least one pinned #167 artifact-policy or byte-geometry invariant. Do not treat the candidate as a valid preferred-budget diagnostic layout until the violations are resolved.',
  };
}

export function verifyPinnedEndpointEmbeddingArtifactPolicyContract() {
  const analysis = evaluateEndpointEmbeddingArtifactPolicyContract();
  if (analysis.status !== 'pass') {
    const codes = analysis.violations.map((item) => item.code).join(', ');
    throw new Error(`pinned endpoint embedding artifact policy contract failed: ${codes}`);
  }
  return analysis;
}

function main(argv) {
  if (argv.length !== 0) {
    throw new Error('usage: verify_endpoint_embedding_artifact_policy_contract.mjs');
  }
  process.stdout.write(`${JSON.stringify(verifyPinnedEndpointEmbeddingArtifactPolicyContract(), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
