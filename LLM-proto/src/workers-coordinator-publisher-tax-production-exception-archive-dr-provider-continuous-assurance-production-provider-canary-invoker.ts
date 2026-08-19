const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export interface ProductionProviderCanaryInvokerBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ProductionProviderCanaryInvokerOptions {
  readonly providerCanary: ProductionProviderCanaryInvokerBinding;
  readonly controllerSecret: string;
}

export async function handleProductionProviderCanaryInvokerRequest(
  request: Request,
  options: ProductionProviderCanaryInvokerOptions,
): Promise<Response> {
  const url = new URL(request.url);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return Response.json({ error: 'provider-canary-invoker-loopback-only' }, { status: 403 });
  }
  if (request.method !== 'POST' || url.pathname !== '/invoke') {
    return new Response('not found', { status: 404 });
  }
  if (!options.controllerSecret) {
    return Response.json({ error: 'provider-canary-invoker-secret-missing' }, { status: 503 });
  }
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return Response.json({ error: 'provider-canary-invoker-json-required' }, { status: 415 });
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength === 0 || body.byteLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: 'provider-canary-invoker-body-size-invalid' }, { status: 413 });
  }

  const upstream = await options.providerCanary.fetch(new Request('https://provider-canary.internal/__run', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-unzen-provider-canary-secret': options.controllerSecret,
    },
    body,
  }));
  const responseBody = await upstream.arrayBuffer();
  const responseContentType = upstream.headers.get('content-type') ?? 'application/json';
  return new Response(responseBody, {
    status: upstream.status,
    headers: {
      'content-type': responseContentType,
      'cache-control': 'no-store',
    },
  });
}
