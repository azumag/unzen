# Durable Coordinator resume checkpoint preflight

Issue #185 tightens the pull-model continuation boundary in `DurableCoordinator`.

## Contract

For segment 0, execution starts without a predecessor checkpoint as before.

For every continuation segment (`segmentIndex > 0`), the Coordinator now performs a synchronous preflight **before selecting a worker, issuing a lease, appending an attempt, or marking a worker busy**. The predecessor checkpoint must:

- exist in the durable repository;
- belong to the same request;
- have `segmentIndex === currentSegment - 1`;
- carry the active model manifest digest;
- still be inside its checkpoint TTL.

A missing, mismatched, or expired predecessor is a terminal `checkpoint-integrity-mismatch`. The continuation executor is not called, no new attempt/lease is created, and no worker capacity is consumed. Expired checkpoints are deleted before the request is finalized.

This keeps cleanup races fail-closed: if periodic checkpoint cleanup removes the predecessor between segment commits, the next segment cannot run with `checkpoint: undefined`. It also avoids the previous expired-checkpoint path where a worker could be marked busy before the Coordinator returned early.

## Validation

`tests/durable-coordinator-checkpoint-preflight.test.ts` covers:

- predecessor already removed by cleanup;
- predecessor still present but expired;
- stored predecessor identity no longer matching the request/model run;
- normal two-segment continuation with the validated predecessor checkpoint.

The failure cases assert that only segment 0 reached the executor, no active lease remains, no second attempt is appended, and the registered worker remains idle.

## Scope

This change only strengthens continuation preflight. It does not define restart recovery policy (#183), cancellation semantics (#184), or the async result-commit race tracked by #182.
