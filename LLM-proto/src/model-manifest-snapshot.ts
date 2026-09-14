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
 * The validator passes an already-owned plain candidate into this helper. Keep
 * that candidate's property insertion order while replacing mutable containers:
 * the current manifest digest contract serializes nested segment/runtime objects
 * with JSON.stringify(), so reordering otherwise-valid JSON fields would change
 * the digest. Optional properties omitted by the caller therefore also remain
 * omitted in the owned snapshot.
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
    ...manifest,
    segments,
    runtimeRequirements,
  });
}

function snapshotSegmentArtifact(artifact: SegmentArtifact): SegmentArtifact {
  const compatibleRuntimes = Object.freeze([...artifact.compatibleRuntimes]);
  const components =
    artifact.components === undefined
      ? undefined
      : Object.freeze(artifact.components.map(snapshotArtifactComponent));

  const snapshot: SegmentArtifact = {
    ...artifact,
    compatibleRuntimes,
    ...(components === undefined ? {} : { components }),
  };
  return Object.freeze(snapshot);
}

function snapshotArtifactComponent(
  component: SegmentArtifactComponent,
): SegmentArtifactComponent {
  return Object.freeze({ ...component });
}
