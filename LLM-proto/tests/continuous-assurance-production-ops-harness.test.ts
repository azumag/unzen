import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  handleProductionProviderCanaryInvokerRequest,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary-invoker.js';

const SECRET = 'provider-canary-controller-secret-fixture';

describe('continuous assurance production ops harness', () => {
  it('forwards a localhost request to the remote provider-canary Service Binding without returning the controller secret', async () => {
    let bindingCalls = 0;
    let forwarded: Request | undefined;
    const body = JSON.stringify({ canaryRunId: 'canary-1', nowMs: 123, authorization: { id: 'auth-1' } });
    const response = await handleProductionProviderCanaryInvokerRequest(
      new Request('http://127.0.0.1:8791/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      {
        controllerSecret: SECRET,
        providerCanary: {
          async fetch(input, init) {
            bindingCalls += 1;
            forwarded = input instanceof Request ? input : new Request(input, init);
            expect(new URL(forwarded.url).pathname).toBe('/__run');
            expect(forwarded.headers.get('x-unzen-provider-canary-secret')).toBe(SECRET);
            expect(await forwarded.clone().text()).toBe(body);
            return Response.json({ status: 'captured' }, { status: 201 });
          },
        },
      },
    );

    expect(bindingCalls).toBe(1);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('captured');
    expect(await new Response(await response.clone().arrayBuffer()).text()).not.toContain(SECRET);
  });

  it('rejects non-loopback requests before touching the remote binding', async () => {
    let bindingCalls = 0;
    const response = await handleProductionProviderCanaryInvokerRequest(
      new Request('https://example.com/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      {
        controllerSecret: SECRET,
        providerCanary: {
          async fetch() {
            bindingCalls += 1;
            return new Response();
          },
        },
      },
    );
    expect(response.status).toBe(403);
    expect(bindingCalls).toBe(0);
  });

  it('keeps the invoker local-only and connects to the deployed controller with a remote Service Binding', async () => {
    const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
    const config = await readFile(join(root, 'worker-runtime', 'wrangler.production-provider-canary-invoker.jsonc'), 'utf8');
    expect(config).toContain('"workers_dev": false');
    expect(config).toContain('"preview_urls": false');
    expect(config).toContain('"service": "unzen-llm-continuous-assurance-production-provider-canary"');
    expect(config).toContain('"remote": true');
    expect(config).toContain('"ip": "127.0.0.1"');
    expect(config).toContain('"port": 8791');
    expect(config).not.toContain('"routes"');
    expect(config).not.toContain('"crons"');
  });

  it('keeps the GitHub production workflow manual-only and defaults to a non-mutating plan', async () => {
    const repoRoot = decodeURIComponent(new URL('../..', import.meta.url).pathname);
    const workflow = await readFile(join(repoRoot, '.github', 'workflows', 'continuous-assurance-production-ops.yml'), 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s*push:/m);
    expect(workflow).not.toMatch(/^\s*schedule:/m);
    expect(workflow).toContain('default: plan');
    expect(workflow).toContain('environment: production');
    expect(workflow).toContain("inputs.mode == 'deploy'");
    expect(workflow).toContain('deploy-continuous-assurance-production-canary.mjs --apply');
    expect(workflow).toContain('actions/upload-artifact@v4');
    expect(workflow).toContain('${{ secrets.PROVIDER_CANARY_CONTROLLER_SECRET }}');
    expect(workflow).not.toContain(SECRET);
  });
});
