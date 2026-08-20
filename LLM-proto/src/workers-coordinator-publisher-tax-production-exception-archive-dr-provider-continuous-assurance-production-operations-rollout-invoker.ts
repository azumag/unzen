const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export interface ProductionOperationsRolloutInvokerBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ProductionOperationsRolloutInvokerOptions {
  readonly rolloutController: ProductionOperationsRolloutInvokerBinding;
  readonly controllerSecret: string;
}

export async function handleProductionOperationsRolloutInvokerRequest(
  request: Request,
  options: ProductionOperationsRolloutInvokerOptions,
): Promise<Response> {
  const url = new URL(request.url);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return Response.json({ error: 'production-rollout-invoker-loopback-only' }, { status: 403 });
  }
  if (request.method !== 'POST' || url.pathname !== '/invoke') return new Response('not found', { status: 404 });
  if (!options.controllerSecret) {
    return Response.json({ error: 'production-rollout-invoker-secret-missing' }, { status: 503 });
  }
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return Response.json({ error: 'production-rollout-invoker-json-required' }, { status: 415 });
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength === 0 || body.byteLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: 'production-rollout-invoker-body-size-invalid' }, { status: 413 });
  }
  const upstream = await options.rolloutController.fetch(new Request('https://rollout.internal/__run', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-unzen-rollout-secret': options.controllerSecret,
    },
    body,
  }));
  const responseBody = await upstream.arrayBuffer();
  return new Response(responseBody, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}
