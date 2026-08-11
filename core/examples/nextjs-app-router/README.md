# Unzen Next.js App Router Example

This example verifies the integration path from `core/docs/nextjs-integration.md`.
It mounts Unzen under a Next.js App Router Route Handler, serves the browser
client and QuickJS worker from `public/unzen/`, serves the cache Service Worker
from the public root, and runs a function from a React Client Component with
`callWithDiagnostics()`.

## Run locally

From this directory:

```bash
npm install
npm run dev
```

Then check the API endpoint:

```bash
curl http://localhost:3000/api/unzen/manifest
```

Open `http://localhost:3000` and press **Run validation**. The result should
include:

- `success: true`
- `result.valid: true`
- `diagnostics.executedOn: "browser"` when the QuickJS worker loads correctly

If `diagnostics.executedOn` is `"server"`, the server fallback is working but
the browser worker path should be checked. Confirm that both files exist:

```bash
ls public/unzen/client.js public/unzen/worker.js public/unzen-cache-worker.js
```

## Runtime E2E

After installing dependencies in `core/` and in this example, run the full
runtime smoke test from this directory:

```bash
npm run test:e2e
```

The script builds the example, starts `next start`, checks
`/api/unzen/manifest`, fetches the `jsonSchemaValidate` code URL, posts to
`/api/unzen/exec/jsonSchemaValidate`, verifies both worker assets, and then
uses Playwright Chromium to click **Run validation** in the browser. It also
checks that the hash-addressed function code is in `unzen-code-v1` and remains
readable after the browser context goes offline. The test fails if the browser
result is not `success: true`, if `result.valid` is not `true`, or if
`diagnostics.executedOn` is not `"browser"`.

If Playwright browsers have not been installed in the environment yet, run:

```bash
npx playwright install chromium
```

## CI

GitHub Actions runs this smoke test through
`.github/workflows/nextjs-runtime-e2e.yml` on pull requests and `main` pushes
that touch `core/packages/**`, `core/package*.json`, this example, or the
workflow itself. The job installs `core/` dependencies with `npm ci`, installs
this example's dependencies without writing a lockfile, installs Playwright
Chromium with system dependencies, and then runs `npm run test:e2e`.

When the browser diagnostics step fails, the runtime E2E script writes
`test-results/nextjs-runtime-e2e/browser-failure.png` and
`test-results/nextjs-runtime-e2e/trace.zip`. The workflow uploads those files
as the `nextjs-runtime-e2e-artifacts` artifact only on failed runs. Open the
failed Actions run, download that artifact, and inspect the screenshot or run:

```bash
npx playwright show-trace trace.zip
```

## What the sample covers

- `app/api/unzen/[[...route]]/route.ts` forwards the full Next.js `Request` to
  a Hono app.
- `lib/unzen.ts` mounts `server.middleware()` at `/api/unzen` so
  `/api/unzen/manifest`, `/api/unzen/code/:name`, and `/api/unzen/exec/:name`
  match correctly.
- `scripts/copy-unzen-assets.mjs` copies `@unzen/client` browser bundles into
  `public/unzen/` and places `unzen-cache-worker.js` at the public root for `/`
  scope.
- `app/components/UnzenDemo.tsx` initializes `UnzenClient` with
  `workerUrl: '/unzen/worker.js'`, best-effort registers the cache worker, and
  calls `callWithDiagnostics()`.
- `scripts/runtime-e2e.mjs` starts the production build and verifies the
  manifest, code, exec, worker assets, browser diagnostics, and offline code
  cache path.
