# Endpoint payload verifier open boundary

The independent endpoint-payload verifier treats every materialized payload as untrusted filesystem state until its file descriptor has been pinned and validated.

For each `payload-*.bin` entry, the verifier first records the entry signature relative to the already pinned payload-directory descriptor. The subsequent hashing open remains relative to that same directory descriptor and requests `O_NOFOLLOW`, `O_NONBLOCK`, `O_CLOEXEC`, and `O_BINARY` where the platform exposes them. The opened descriptor must still be a regular file, must match the directory-entry signature observed around the open, and must remain unchanged through the complete hash pass. The directory entry is checked again after hashing before the digest is accepted.

`O_NONBLOCK` is part of the trust boundary rather than a performance option. A regular payload can be replaced after the pre-open metadata check. If that replacement is a FIFO or another special file, a normal blocking open could wait before the post-open regular-file check runs. Requesting non-blocking mode lets that race reach the descriptor validation path without turning verification into an unbounded wait.

`O_BINARY` preserves byte identity on platforms whose CRT distinguishes text and binary descriptors. SHA-256 is therefore defined over the exact persisted payload bytes, including CRLF sequences and control bytes such as `0x1a`; no newline or end-of-file translation is permitted before hashing.

These checks do not broaden the endpoint payload contract. Payload names, source-range comparisons, pinned-directory traversal, report schema, budget calculations, and the diagnostic-only status are unchanged. The change only strengthens the filesystem boundary used while independently verifying already materialized payloads.
