# Model Manifest (SegmentedModelManifest)

The model manifest is the single source of truth for segment geometry. Issue
[#102](https://github.com/azumag/unzen/issues/102) replaced the hard-coded
model geometry in `Coordinator.buildSegmentConfigs()` (60 layers / 17GB / 8
segments / placeholder `sha256:segment-${i}` hashes) with a versioned,
validated manifest so that:

- a user can change the model and the types no longer "look correct" by
  accident;
- a config whose real artifact hashes do not match cannot generate an
  execution plan;
- a geometry-free backend (if one is ever introduced through the #94
  abstraction) is kept separate from segment geometry.

## Manifest Shape

`src/model-manifest.ts` defines:

| Field | Purpose |
|---|---|
| `schemaVersion` | Versioned manifest schema (`1.0.0`). Unsupported versions fail fast. |
| `modelId` / `modelRevision` | Identifies the exact model artifact; run reports carry these. |
| `architecture` / `parameterCount` / `tokenizer` | Model identity metadata. |
| `quantization` | Quantization format string, e.g. `q4` / `fp16` (see `parseQuantizationBits`). |
| `totalLayers` | Total transformer layers; segments must cover `0..totalLayers-1`. |
| `segments` | `SegmentArtifact[]` - one entry per weight shard (see below). |
| `checkpointFormat` | Checkpoint dtype, e.g. `float16`. |
| `runtimeRequirements` | `minimumVramMB`, `supportedQuantization`, `minimumRuntimeVersion`, `minimumChromeVersion`. |
| `manifestDigest` | SHA-256 over the canonical manifest fields. |
| `signature?` | Optional signature over `manifestDigest`. |
| `source` | Fixture namespace marker: `'production'` or `'fixture'`. |

Each `SegmentArtifact` carries:

| Field | Purpose |
|---|---|
| `index` | Stable zero-based segment id (must be unique and cover `0..n-1`). |
| `layerStart` / `layerEnd` | Contiguous layer range (inclusive). |
| `byteSize` | Exact artifact byte size. |
| `sha256` | Exact lowercase hex SHA-256 of the artifact. Placeholders such as `sha256:segment-0` are rejected. |
| `contentType` / `encoding` | Content type and optional encoding, e.g. `application/octet-stream` + `zstd`. |
| `artifactLocator` | CDN artifact path (unzen-managed origin). |
| `estimatedMemoryMB` | Estimated peak VRAM while the segment is resident. |
| `memoryBasis` | `measured` / `budgeted` / `estimated` - only `measured` is a real measurement. |
| `measurementConditions` | Conditions under which the measurement/estimate was taken. |
| `compatibleRuntimes` / `minimumRuntimeVersion` | Runtime compatibility gate. |

`SegmentConfig` (the execution-facing type) is now derived from manifest
artifacts via `segmentConfigsFromManifest()`.

## Validation

`src/model-manifest-validator.ts` fail-fasts at startup on:

- unsupported `schemaVersion`;
- non-production `source` when a production source is required (fixture
  manifests are rejected by the production code path);
- duplicate or missing segment indexes;
- non-contiguous or overlapping layer ranges;
- layer ranges outside `totalLayers` or segments that do not cover
  `0..totalLayers-1`;
- invalid artifact byte size / digest format and placeholder hashes
  (`sha256:segment-...` or non-hex values are REJECTED);
- quantization format and runtime compatibility
  (`quantization` must be listed in `runtimeRequirements.supportedQuantization`);
- invalid `manifestDigest` format;
- `manifestDigest` mismatch against the recomputed canonical digest (async);
- optional signature mismatch (async, verifier callback supplied by the
  caller, following the `evidence.ts` trusted-verifier pattern);
- segment count mismatch against Coordinator options (checked in the
  `Coordinator` constructor).

`Coordinator` calls `assertValidModelManifest()` in its constructor with
`allowedSources: ['production']`, so an invalid, placeholder-hash, or fixture
manifest throws at startup instead of driving an execution plan. Tests opt in
to fixture manifests with `allowFixtureManifest: true`.

## Fixture Namespace

`src/model-manifest-fixtures.ts` builds test manifests marked
`source: 'fixture'`. Fixtures carry a deterministic *synthetic* digest (valid
hex format, not a real SHA-256); the async full validator reports a digest
mismatch for them, so a fixture can never pass production-level verification.

The default fixture mirrors the historical planning example: 30B-class q4,
60 layers, 8 segments, ~2.1GB per segment. These values are an **EXAMPLE for
feasibility planning, not measured fact** - the fixture's `memoryBasis` is
`budgeted` and its `measurementConditions` state that the numbers are
synthetic.

## Browser-managed full-model backend

> 破棄済み: Chrome Prompt API / Built-in AI 採用方針（#92/#93/#95/#100）は、実ブラウザ計測で特別な設定なしには API が露出しないことが確認されたため破棄しました。`src/browser-built-in-model.ts` は削除済みです。`browser-built-in-full-model` kind は #94 の抽象化としてのみ残り、具体的な実装はありません。

## Focused Test Command

```bash
cd LLM-proto
npm test -- --run tests/model-manifest-validator.test.ts
npm test -- --run tests/coordinator.test.ts
npm test -- --run tests/webgpu-30b-feasibility.test.ts
```
