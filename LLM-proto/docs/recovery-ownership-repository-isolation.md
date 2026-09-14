# Recovery ownership repository isolation

Recovery ownership is a short-lived coordination record, but it is still durable state. Repository adapters therefore treat it as an ownership boundary rather than exposing caller or storage object identities.

## Contract

`claimRecoveryOwnership()` captures exactly these fields from the caller-owned record, once each and without object enumeration:

- `requestId`
- `ownerId`
- `claimedAt`
- `expiresAt`

The repository persists a new plain record built from that snapshot. Retaining and mutating the object passed to `claimRecoveryOwnership()` cannot alter the stored claim.

`getRecoveryOwnership()` always returns a detached plain record. Mutating a value returned from a read cannot change persisted ownership, expiry, or compare-and-delete release identity.

The rule applies to both `InMemoryRepository` and `DurableObjectRepository`. The Durable Object adapter does not rely on a particular `ctx.storage.kv` implementation to structured-clone values; the repository boundary itself establishes the observable isolation contract.

## Recovery command consequence

`beginDurableRecovery()` may return the same command-local ownership object in `resume-claimed`, but repository persistence already owns a separate snapshot. A consumer can therefore retain or mutate the returned value without mutating the repository record. Release and peer-ownership decisions continue to use persisted `ownerId` and expiry values.

## Scope

This hardening changes reference ownership only. It does not change claim/renew/peer semantics, recovery TTL policy, retry policy, or provide new real-model/WebGPU/multi-browser evidence for #167.
