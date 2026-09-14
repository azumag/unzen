# Active lease repository isolation

Active leases carry the identity fence used for result matching, reclaim, restart recovery, and expiry decisions. The repository therefore owns lease records rather than exposing caller or storage object identities.

## Contract

`putLease()` captures exactly these fields from a caller-owned lease, once each and without object enumeration:

- `leaseId`
- `requestId`
- `attemptId`
- `workerId`
- `workerGeneration`
- `segmentIndex`
- `modelManifestDigest`
- `issuedAt`
- `expiresAt`

The repository persists a new plain record built from that snapshot. Mutating the object passed to `putLease()` afterwards cannot alter persisted assignment identity or expiry.

`getActiveLease()` and `listActiveLeases()` return detached plain records. A consumer may mutate a returned object without changing the active lease kept by the repository. This contract is explicit in both `InMemoryRepository` and `DurableObjectRepository`; it does not rely on the backing Durable Object KV implementation to structured-clone values.

## Replacement and recovery semantics

The Durable Object adapter derives both the active request key and the lease-index key from the same owned snapshot. Replacing an active lease still removes the prior lease index before storing the new lease and index.

Because recovery planning receives a detached active lease, a `wait-active-owner` result no longer exposes repository state by reference. Mutating that result cannot shorten expiry, alter lease identity, or change the later compare/reclaim decision.

## Scope

This change is reference-isolation hardening only. It does not change lease TTL policy, result matching, retry policy, or provide new real-model/WebGPU/multi-browser evidence for #167. #158 remains HOLD.
