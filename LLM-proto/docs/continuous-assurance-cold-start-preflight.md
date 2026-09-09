# Continuous Assurance cold-start preflight

Tracking: #190.

## Purpose

The production deployment canary requires an engine snapshot with finite `snapshotUpdatedAtMs` and `nextDueAtMs`. On a genuinely empty engine state, the current production sequence is blocked by the known #190 bootstrap dependency cycle.

`tools/continuous-assurance-cold-start-preflight.mjs` classifies a captured engine canary-state JSON document **before** operators attempt the production deployment canary. It is diagnostic only: it does not seed engine state, weaken any gate, choose a genesis authorization design, access Cloudflare credentials, or produce production evidence.

## Usage

Capture the existing authorized engine `GET /__canary/state` response through the normal operator tooling, keep secrets out of the file, then run:

```sh
npm run ops:preflight-continuous-assurance-cold-start -- ./engine-state.json
```

Standard input is also supported:

```sh
cat ./engine-state.json | npm run ops:preflight-continuous-assurance-cold-start -- -
```

The command prints one machine-readable JSON object.

## Exit status

- `0`: `status=pass`; both required snapshot timestamps are finite safe integers and the deployment canary may continue to its existing gates.
- `2`: `status=hold`; the state is the known empty cold-start shape and #190 still requires a design decision.
- `1`: `status=invalid`; the state is malformed or partially initialized and must not be treated as the known cold-start cycle.
- `64`: command usage error.

A HOLD result contains `issue: 190`, `kind: cold-start-bootstrap-cycle`, and `decision: design-decision-required`. It deliberately does not recommend one of the bootstrap alternatives from #190.

## Input contract

The preflight consumes the non-secret state fields already returned by the engine canary state endpoint:

```json
{
  "scope": "publisher-tax-exception-archive-dr",
  "currentRunId": null,
  "snapshotUpdatedAtMs": null,
  "nextDueAtMs": null
}
```

A ready state requires both timestamp fields to be non-negative JavaScript safe integers. Strings, fractional values, negative values, invalid `currentRunId` values, and one-sided/partial snapshots fail closed.

## Boundary

This preflight only prevents an operator from confusing the known #190 cold-start deadlock with a malformed existing snapshot. The acceptance criteria of #190 remain open until a maintainer explicitly selects and implements a safe genesis/bootstrap design and that path is validated in the real Cloudflare environment.
