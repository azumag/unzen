# BackendRegistry backend-id contract

A `backendId` is the exact identity used to key capability routing state. TypeScript's `string` annotation does not validate values arriving from JavaScript, assertions, or decoded integration data, so registration validates the identity before touching either active entries or pending async-registration reservations.

Both `register()` and `registerCapability()` require `backendId` to be:

- a string;
- non-empty;
- not whitespace-only.

Valid identifiers are not trimmed or normalized. For example, `" backend-a "` and `"backend-a"` remain distinct keys. This matches the registry's exact-identity semantics and avoids silently merging namespaces.

The identity check runs before duplicate detection and before a pending reservation is created. Invalid input therefore cannot poison the reservation set, and a later valid registration remains possible. Existing duplicate-id rejection and async registration atomicity are unchanged.
