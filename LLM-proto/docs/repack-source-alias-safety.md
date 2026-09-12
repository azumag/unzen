# Repack source-alias safety

`tools/prepare_real_split.py` streams only the external-data byte ranges required by each extracted ONNX segment into a segment-local payload.

The destination payload is a write target, while the source external-data blobs are read-only inputs. Before the destination is opened, `repack_segment_external_data()` preflights every external initializer and compares the destination identity with every referenced source file.

Source locations and the requested output location must be cross-platform-safe relative artifact paths. POSIX/Windows absolute paths, drive/root paths, parent traversal, colon-bearing components, Windows reserved device/port basenames (including extension and superscript variants), trailing dot/space components, and empty locations are rejected. Ordinary nested relative paths remain valid.

The destination is also compared with the model graph itself. A caller therefore cannot turn the external-data write into an overwrite of the `.onnx` graph.

The source/destination comparison covers normal resolved-path aliases and, when both entries already exist, filesystem identity via `samefile()`. This means a direct same-path destination, a symlink to the source, or an existing hard-link alias is rejected before `wb` can truncate the source blob.

The same preflight parses all external-data ranges, opens every unique source file for reading, and validates each declared `offset + length` against the opened file size before any destination write. Missing, unreadable, malformed, or truncated source inputs therefore fail without creating a new destination payload or truncating an existing one. Source descriptors are kept open for the copy and closed on both success and failure.

This is a local artifact-generation safety contract. It does not relax browser artifact budgets, prove WebGPU execution, or provide production deployment evidence.
