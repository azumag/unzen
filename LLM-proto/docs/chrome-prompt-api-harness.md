# Chrome Prompt API Feasibility Harness

This document covers the Chrome Built-in AI / Prompt API feasibility harness
(issue #93). The Prompt API is a candidate inference resource for Unzen, but it
lives in the **DOCUMENT execution context** (not a Dedicated Web Worker) and its
model preparation has its own lifecycle: availability, user activation, first
download, and language.

The harness measures feasibility in a real Chrome session. Everything in this
package is a **fixture / schema contract** until a human runs the harness and an
operator wraps the resulting report in a `captured-and-verified` evidence
envelope.

- Reference: https://developer.chrome.com/docs/ai/prompt-api
- Schema + validator: [`src/chrome-prompt-api-report.ts`](../src/chrome-prompt-api-report.ts)
- Contract tests: [`tests/chrome-prompt-api-report.test.ts`](../tests/chrome-prompt-api-report.test.ts)
- Evidence rules: [`evidence-readiness.md`](./evidence-readiness.md), [`evidence.ts`](../src/evidence.ts)

## Go / Conditional Go / No-Go / 未解決条件 Recording

The decision gate `evaluateChromePromptApiFeasibilityDecision()` produces this
recording. Until a human runs the harness in Chrome **and** an operator wraps the
report in a validated `captured-and-verified` envelope (artifact loader +
independent verifier), the recording MUST stay `not-evaluated` (未解決条件). A
hand-written fixture can never be recorded as Go: the gate derives readiness from
`validateEvidenceEnvelope()` only, never from report fields.

> [!IMPORTANT]
> Current recording = **未解決条件 (not-evaluated) — pending real-browser
> measurement**. No measured result is claimed in this document.

| Condition | Current recording | Required to flip to met |
|---|---|---|
| real-browser-evidence | pending real-browser measurement | validated `captured-and-verified` envelope for this run |
| prompt-api-availability | pending real-browser measurement | top-level availability reaches `available` |
| create-after-user-activation | pending real-browser measurement | `create()` succeeds within a user activation |
| first-download-preparation | pending real-browser measurement | first download completes; monitor progress observed |
| prompt-non-streaming | pending real-browser measurement | `prompt()` returns text with measured timing |
| prompt-streaming | pending real-browser measurement | `promptStreaming()` streams chunks with measured timing |
| japanese-input-output | pending real-browser measurement | Japanese input accepted and Japanese output produced |
| abort-interruption | pending real-browser measurement | `AbortSignal` interrupts generation |
| context-usage-and-overflow | pending real-browser measurement | context window read; overflow/quota handled |
| session-lifecycle | pending real-browser measurement | destroy + re-create succeed |
| concurrent-sessions | pending real-browser measurement | N concurrent sessions execute without errors |
| surface-matrix | pending real-browser measurement | top-level/same-origin/sandbox surfaces recorded |

Decision derivation:

| Decision | Meaning |
|---|---|
| `not-evaluated` (未解決条件) | no validated real-browser evidence (current state) |
| `go` | every condition met with captured-and-verified evidence |
| `conditional-go` | evidence verified but some scenario not applicable / pending |
| `no-go` | evidence verified but a scenario failed |

## Focused Test Command

```bash
cd LLM-proto
npm run test:chrome-prompt-api
```

Full regression bar:

```bash
cd LLM-proto
npm test -- --run
npx tsc -p tsconfig.json --noEmit
```

Note: `tsc` currently reports one pre-existing error in `src/evidence.ts` (a
`Uint8Array<ArrayBufferLike>` vs `BufferSource` lib mismatch); the new modules do
not add errors.

## Manual Browser Measurement Path

Run this on a real Chrome with the Built-in AI / Prompt API available. The model
download takes time on the first run.

1. Serve the harness from a local origin (the Prompt API is not available on
   arbitrary `file://` or insecure origins):
   ```bash
   cd LLM-proto/browser-harness/chrome-prompt-api
   python3 -m http.server 8787
   # open http://localhost:8787/ in Chrome
   ```
2. Confirm the banner reports "Chrome Built-in AI / Prompt API detected".
3. Click **Run scenarios**. This user activation is required for the first model
   download. The page logs each scenario; nothing should crash the page.
4. When the run completes, **Download report JSON** (or copy it). The report is
   SELF-REPORTED.
5. Save the JSON next to this doc or in an artifact store; record browser version
   and OS from the report's `environment` block.

### What the harness exercises

| Scenario | What is recorded |
|---|---|
| `availability-state-transitions` | `unavailable` / `downloadable` / `downloading` / `available` transitions and samples |
| `create-without-user-activation` | whether a gesture-free `create()` is rejected (`not-allowed`) |
| `create-after-user-activation` | `sessionCreateMs`, whether the first download happened during create |
| `download-progress-monitor` | `monitor` wiring and `downloadprogress` samples |
| `prompt-non-streaming` | latency to first token, token count, tokens/sec |
| `prompt-streaming` | first chunk/token latency, chunk count, tokens/sec |
| `expected-inputs-outputs` | Japanese input accepted and Japanese output produced |
| `abort-interruption` | `AbortSignal` interruption and truncation |
| `context-usage-and-overflow` | `contextWindow`, used tokens, overflow/quota errors |
| `session-destroy-recreate` | destroy + re-create timing |
| `concurrent-sessions` | concurrent session/execution counts and errors |
| `surface-matrix` | top-level, same-origin iframe, sandbox iframe availability/use |

Surface matrix limits: this page can only probe same-origin and sandbox iframes
itself. **cross-origin iframe** requires a separately served origin running its
own copy of the harness; **extension page** requires an extension host. Both are
recorded as `tested: false` until a dedicated run is made.

## From self-reported to captured-and-verified

A self-reported report is diagnostic only. To upgrade it to
`real-browser-verified`:

1. Save the downloaded JSON as an artifact (e.g.
   `artifacts/chrome-prompt-api/<runId>/report.json`).
2. Compute its SHA-256 and construct a `captured-and-verified`
   `EvidenceEnvelope` whose `payload` is the report (see the fixture builders in
   [`tests/chrome-prompt-api-fixtures.ts`](../tests/chrome-prompt-api-fixtures.ts)
   for the shape).
3. Validate with `validateChromePromptApiFeasibilityReport(report, {
   evidenceValidation: { trustedVerifiers, loadArtifact, verifyArtifact } })`.
   Readiness is `real-browser-verified` only when the shared
   `validateEvidenceEnvelope()` returns `valid` for the captured level.
4. Re-run `evaluateChromePromptApiFeasibilityDecision()`; only then may the Go /
   No-Go table above be updated with measured values.

A hand-written fixture cannot reach this state: without a trusted artifact
loader and an independent verifier, `validateEvidenceEnvelope()` returns
`not-evaluated`, and the report readiness stays `not-evaluated`.

## Advance / Stop Conditions

Advance the Chrome backend toward issue #100 (E2E / compatibility matrix /
rollout) only when:

- the decision recording is `go` or `conditional-go` backed by
  `captured-and-verified` evidence;
- top-level, same-origin iframe, and sandbox iframe surfaces are recorded;
- Japanese input/output, abort, context, and session lifecycle scenarios pass;
- the report's `environment` records Chrome version/channel, OS, and GPU so the
  compatibility matrix is reproducible.

Open a follow-up issue instead when:

- the model never reaches `available` on the target channel;
- `create()` requires an unavailable activation pattern (e.g. no user-facing
  consent surface);
- streaming or abort behave inconsistently across Chrome channels;
- a critical surface (cross-origin iframe / extension page) shows the API is
  unusable where Unzen needs it.
