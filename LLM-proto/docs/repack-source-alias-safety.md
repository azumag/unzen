# Repack source-alias safety

`tools/prepare_real_split.py` streams only the external-data byte ranges required by each extracted ONNX segment into a segment-local payload.

The destination payload is a write target, while the source external-data blobs are read-only inputs. Before the destination is opened, `repack_segment_external_data()` now preflights every external initializer and compares the destination identity with every referenced source file.

The comparison covers normal resolved-path aliases and, when both entries already exist, filesystem identity via `samefile()`. This means a direct same-path destination, a symlink to the source, or an existing hard-link alias is rejected before `wb` can truncate the source blob.

The same preflight also parses all external-data ranges before any destination write. A malformed later initializer therefore cannot leave a partially repacked payload merely because an earlier initializer was valid.

This is a local artifact-generation safety contract. It does not relax browser artifact budgets, prove WebGPU execution, or provide production deployment evidence.
