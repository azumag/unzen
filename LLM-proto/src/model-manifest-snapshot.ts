import type {
  SegmentArtifact,
  SegmentArtifactComponent,
  SegmentedModelManifest,
} from './model-manifest.js';

/**
 * Take runtime ownership of a structurally validated model manifest.
 *
 * Manifest inputs typically originate from parsed JSON, but callers can still
 * retain mutable references after validation. Keeping those references would
 * allow model identity, geometry, runtime policy, or artifact metadata to drift
 * after the validator has accepted them. This helper copies and freezes every
 * declared mutable container that participates in manifest identity.
 *
 * Optional properties that were omitted by the caller remain omitted in the
 * owned snapshot. This preserves the established runtime object-shape contract
 * while still detaching every declared mutable container.
 */
export function snapshotValidatedModelManifest(
  manifest: SegmentedModelManifest,
): SegmentedModelManifest {
  const segments = Object.freeze(manifest.segments.map(snapshotSegmentArtifact));
  const runtimeRequirements = Object.freeze({
    ...manifest.runtimeRequirements,
    supportedQuantization: Object.freeze([
      ...manifest.runtimeRequirements.supportedQuantization,
    ]),
  });

  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    modelId: manifest.modelId,
    modelRevision: manifest.modelRevision,
    architecture: manifest.architecture,
    parameterCount: manifest.parameterCount,
    quantization: manifest.quantization,
    totalLayers: manifest.totalLayers,
    tokenizer: manifest.tokenizer,
    segments,
    checkpointFormat: manifest.checkpointFormat,
    runtimeRequirements,
    manifestDigest: manifest.manifestDigest,
    ...(manifest.signature === undefined ? {} : { signature: manifest.signature }),
    source: manifest.source,
  });
}

function snapshotSegmentArtifact(artifact: SegmentArtifact): SegmentArtifact {
  const compatibleRuntimes = Object.freeze([...artifact.compatibleRuntimes]);
  const components =
    artifact.components === undefined
      ? undefined
      : Object.freeze(artifact.components.map(snapshotArtifactComponent));

  return Object.freeze({
    index: artifact.index,
    layerStart: artifact.layerStart,
    layerEnd: artifact.layerEnd,
    byteSize: artifact.byteSize,
    sha256: artifact.sha256,
    contentType: artifact.contentType,
    ...(artifact.encoding === undefined ? {} : { encoding: artifact.encoding }),
    artifactLocator: artifact.artifactLocator,
    ...(components === undefined ? {} : { components }),
    estimatedMemoryMB: artifact.estimatedMemoryMB,
    memoryBasis: artifact.memoryBasis,
    ...(artifact.measurementConditions === undefined
      ? {}
      : { measurementConditions: artifact.measurementConditions }),
    compatibleRuntimes,
    minimumRuntimeVersion: artifact.minimumRuntimeVersion,
  });
}

function snapshotArtifactComponent(
  component: SegmentArtifactComponent,
): SegmentArtifactComponent {
  return Object.freeze({ ...component });
}
