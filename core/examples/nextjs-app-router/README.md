# Unzen Next.js App Router Example

This example verifies the integration path from `core/docs/nextjs-integration.md`.
It mounts Unzen under a Next.js App Router Route Handler, serves the browser
client and QuickJS worker from `public/unzen/`, and runs a function from a
React Client Component with `callWithDiagnostics()`.

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
ls public/unzen/client.js public/unzen/worker.js
```

## Runtime E2E

After installing dependencies in `core/` and in this example, run the full
runtime smoke test from this directory:

```bash
npm run test:e2e
```

The script builds the example, starts `next start`, checks
`/api/unzen/manifest`, fetches the `jsonSchemaValidate` code URL, posts to
`/api/unzen/exec/jsonSchemaValidate`, verifies `/unzen/worker.js`, and then
uses Playwright Chromium to click **Run validation** in the browser. The test
fails if the browser result is not `success: true`, if `result.valid` is not
`true`, or if `diagnostics.executedOn` is not `"browser"`.

If Playwright browsers have not been installed in the environment yet, run:

```bash
npx playwright install chromium
```

## What the sample covers

- `app/api/unzen/[[...route]]/route.ts` forwards the full Next.js `Request` to
  a Hono app.
- `lib/unzen.ts` mounts `server.middleware()` at `/api/unzen` so
  `/api/unzen/manifest`, `/api/unzen/code/:name`, and `/api/unzen/exec/:name`
  match correctly.
- `scripts/copy-unzen-assets.mjs` copies `@unzen/client` browser bundles into
  `public/unzen/`.
- `app/components/UnzenDemo.tsx` initializes `UnzenClient` with
  `workerUrl: '/unzen/worker.js'` and calls `callWithDiagnostics()`.
- `scripts/runtime-e2e.mjs` starts the production build and verifies the
  manifest, code, exec, worker asset, and browser diagnostics path.
