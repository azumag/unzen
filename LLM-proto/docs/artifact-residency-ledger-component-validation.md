# ArtifactResidencyLedger direct-constructor validation

`ArtifactResidencyLedger.fromManifest()` enters through the shared model-manifest validator. The direct constructor is also used by tests and internal integration code, so it must not assume that TypeScript `readonly`, unions, arrays, or string types still exist at runtime.

The constructor validates every `SegmentArtifact` before sorting it or using any field in `trim`, RegExp, numeric comparison, or array spread operations. This prevents malformed asserted/deserialized data from gaining accidental semantics through JavaScript coercion or from failing with an unrelated `TypeError`.

For every top-level segment artifact the direct-constructor boundary requires:

- an object input inside a non-empty artifact array;
- a non-negative safe-integer index, with the complete set covering exactly `0..n-1`;
- non-negative safe-integer layer bounds with `layerEnd >= layerStart`;
- a positive safe-integer byte size;
- a canonical lowercase 64-character hexadecimal SHA-256;
- non-empty content type, primary artifact locator, and minimum runtime version;
- optional encoding and measurement conditions to be strings when present, without adding a new non-empty policy beyond the shared manifest contract;
- a finite positive memory estimate and a known `measured`, `budgeted`, or `estimated` basis;
- a non-empty array of non-empty runtime strings.

When a `SegmentArtifact` contains `components`, the ledger additionally validates the complete logical browser bundle before storing any immutable inventory state:

- the component collection is an array and every component is an object;
- the bundle is non-empty;
- every component role is exactly `graph` or `external-data`;
- every component path is non-empty and unique within the bundle;
- every component byte size is a positive safe integer and the sum remains within JavaScript's safe-integer range;
- every component SHA-256 is canonical lowercase 64-character hexadecimal;
- every component content type and artifact locator is non-empty;
- the bundle contains exactly one graph component;
- the segment's primary `artifactLocator` is exactly the graph component locator;
- component bytes sum exactly to the segment's declared `byteSize`.

Only after all structural checks pass does the ledger copy and freeze the top-level artifact, compatible-runtime array, component array, and component objects. Caller mutation after construction therefore cannot alter routing-visible artifact identity or measured bytes.

This is a structural trust-boundary guarantee. It does not replace full model-manifest digest/signature verification, transport-origin allowlisting, file-content digest verification, or the real multi-browser/WebGPU evidence required by #167.
