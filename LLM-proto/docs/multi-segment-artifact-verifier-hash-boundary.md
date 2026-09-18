# Multi-segment artifact verifier hash boundary

`verify_multi_segment_artifacts.py` treats the lower-level `_measure_file(..., chunk_size=...)` and `sha256_file(..., chunk_size=...)` controls as runtime input rather than relying on Python type annotations.

`chunk_size` must be an exact positive Python integer. Booleans are rejected even though `bool` subclasses `int`; zero, negative values, floats (including `NaN` and infinities), strings, `None`, and other non-integers fail before `os.open()` is called. This prevents `read(0)` from returning an empty-payload digest and prevents negative values such as `-1` from turning the intended bounded loop into a whole-file read.

Valid positive chunk sizes, including the default and small values such as one byte, continue to hash the complete payload. Descriptor-pinned hashing is unchanged: the verifier opens one nonblocking descriptor, requires a regular file, hashes through that descriptor, and compares the before/after stat fingerprint so in-place mutation fails closed. Missing-file behavior and path-replacement resistance are also unchanged.

This contract is defense-in-depth for direct and future programmatic callers. Normal artifact-integrity verification continues to use the default chunk size and does not change the split-manifest schema or any production evidence requirements.