# BackendRegistry registration atomicity

`BackendRegistry.register()` discovers a backend capability asynchronously. The duplicate-id contract must cover the entire discovery/validation interval, not only the moments before and after `await backend.describeCapabilities()`.

The registry therefore reserves a backend id before asynchronous capability discovery starts. While an id is reserved:

- another `register()` for the same id is rejected immediately;
- `registerCapability()` for the same id is also rejected;
- registrations for other ids remain independent.

A successful registration atomically replaces the reservation with the validated, immutable capability entry. If capability discovery, validation, or snapshot creation fails, the reservation is released in a `finally` path so the id can be retried.

The reservation is an internal concurrency guard only. It is not a routable entry, does not change `size`, and is not returned by `describeAll()` or candidate selection. Existing backend lifecycle and disposal behavior remains unchanged.
