# ArtifactResidencyLedger direct-constructor component validation

`ArtifactResidencyLedger.fromManifest()` enters through the shared model-manifest validator. The direct constructor is also used by tests and internal integration code, so it must not assume that TypeScript `readonly` or union types still exist at runtime.

When a `SegmentArtifact` contains `components`, the ledger validates the complete logical browser bundle before storing any immutable inventory state:

- the bundle is non-empty;
- every component role is exactly `graph` or `external-data`;
- every component path is non-empty and unique within the bundle;
- every component byte size is a positive safe integer and the sum remains within JavaScript's safe-integer range;
- every component SHA-256 is canonical lowercase 64-character hexadecimal;
- every component content type and artifact locator is non-empty;
- the bundle contains exactly one graph component;
- the segment's primary `artifactLocator` is exactly the graph component locator;
- component bytes sum exactly to the segment's declared `byteSize`.

Only after those checks pass does the ledger copy and freeze the component array and component objects. Caller mutation after construction therefore cannot alter routing-visible artifact identity or measured bytes.

This is a structural trust-boundary guarantee. It does not replace full model-manifest digest/signature verification, transport-origin allowlisting, file-content digest verification, or the real multi-browser/WebGPU evidence required by #167.
