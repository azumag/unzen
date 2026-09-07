import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { UnzenNetworkError } from '@unzen/shared';
import { FallbackHandler } from '../src/fallback-handler';

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

describe('fallback redirect transport boundary', () => {
  it.each([301, 302, 303, 307, 308])('rejects HTTP %s before contacting a redirected endpoint', async (status) => {
    let redirectedRequests = 0;
    let originRequests = 0;
    const target = createServer((request, response) => {
      redirectedRequests++;
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ result: 'unexpected redirected execution' }));
    });
    const origin = createServer((request, response) => {
      originRequests++;
      request.resume();
      response.writeHead(status, { Location: targetUrl });
      response.end();
    });
    let targetUrl = '';
    try {
      targetUrl = await listen(target);
      const originUrl = await listen(origin);
      // Use native fetch and real loopback HTTP, not a mocked 3xx response:
      // fetch normally hides redirects and can resend the POST body for 307/308.
      const outcome = await new FallbackHandler(originUrl).execute('identity', ['fixture-only'])
        .then((value) => value, (error) => error);
      expect(originRequests).toBe(1);
      expect(redirectedRequests).toBe(0);
      expect(outcome).toBeInstanceOf(UnzenNetworkError);
    } finally {
      await Promise.all([close(origin), close(target)]);
    }
  });
});
