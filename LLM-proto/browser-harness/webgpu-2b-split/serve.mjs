/**
 * Local Coordinator + static server for issue #165 real two-browser split PoC.
 *
 * The server is intentionally simple: browsers never contact each other.
 * Segment 0 uploads the measured boundary tensors to this Coordinator, and
 * segment 1 (or a standby segment-1 browser) retrieves them from here.
 *
 * For the real P0, the Coordinator also issues an HttpOnly probe cookie per
 * browser cookie jar. Tabs in the same Chrome profile share that cookie while
 * distinct profiles use distinct cookie jars. Checkpoint/result writes must
 * return the cookie issued for the registered worker generation, and final
 * profile-isolation evidence is bound to the identities that actually wrote
 * the run rather than to mutable worker IDs alone.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_PORT = Number(process.env.PORT ?? 8791);
const MODELS_DIR = process.env.MODELS_DIR ? resolve(process.env.MODELS_DIR) : undefined;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const PROFILE_PROBE_COOKIE = 'unzen_profile_probe';
const TENSOR_TYPE_BYTES = Object.freeze({
  float64: 8,
  float32: 4,
  float16: 2,
  int64: 8,
  int32: 4,
  int16: 2,
  int8: 1,
  uint64: 8,
  uint32: 4,
  uint16: 2,
  uint8: 1,
  bool: 1,
});
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.data': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

export function createCoordinatorState() {
  return {
    workers: new Map(),
    checkpoints: new Map(),
    results: new Map(),
  };
}

function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      throw new Error(`request body exceeds ${MAX_JSON_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function safeRunId(raw) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(raw)) throw new Error('invalid run id');
  return raw;
}

function safeWorkerId(raw) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(raw)) throw new Error('invalid worker id');
  return raw;
}

function decodedBase64ByteLength(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return undefined;
  if (!CANONICAL_BASE64.test(value)) return undefined;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function validateBoundaryTensors(tensors) {
  if (!Array.isArray(tensors) || tensors.length !== 2) {
    return { ok: false, status: 400, error: 'exactly-two-boundary-tensors-required' };
  }
  const names = new Set();
  let tensorBytes = 0;
  for (const [index, tensor] of tensors.entries()) {
    if (!tensor || typeof tensor !== 'object' || Array.isArray(tensor)) {
      return { ok: false, status: 400, error: 'invalid-boundary-tensor', index, reason: 'tensor-object-required' };
    }
    if (typeof tensor.name !== 'string' || tensor.name.length === 0 || tensor.name.length > 1024) {
      return { ok: false, status: 400, error: 'invalid-boundary-tensor', index, reason: 'invalid-name' };
    }
    if (names.has(tensor.name)) {
      return { ok: false, status: 400, error: 'invalid-boundary-tensor', index, reason: 'duplicate-name', name: tensor.name };
    }
    names.add(tensor.name);
    const elementBytes = TENSOR_TYPE_BYTES[tensor.type];
    if (!elementBytes) {
      return { ok: false, status: 400, error: 'invalid-boundary-tensor', index, reason: 'unsupported-type', type: tensor.type };
    }
    if (!Array.isArray(tensor.dims) || tensor.dims.length === 0 || tensor.dims.length > 8) {
      return { ok: false, status: 400, error: 'invalid-boundary-tensor', index, reason: 'invalid-dims' };
    }
    let elementCount = 1;
    for (const dimension of tensor.dims) {
      if (!Number.isSafeInteger(dimension) || dimension <= 0) {
        return { ok: false, status: 400, error: 'invalid-boundary-tensor', index, reason: 'invalid-dimension' };
      }
      elementCount *= dimension;
      if (!Number.isSafeInteger(elementCount)) {
        return { ok: false, status: 400, error: 'invalid-boundary-tensor', index, reason: 'tensor-size-overflow' };
      }
    }
    const expectedBytes = elementCount * elementBytes;
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
      return { ok: false, status: 400, error: 'invalid-boundary-tensor', index, reason: 'tensor-size-overflow' };
    }
    if (!Number.isSafeInteger(tensor.bytes) || tensor.bytes !== expectedBytes) {
      return {
        ok: false,
        status: 400,
        error: 'invalid-boundary-tensor',
        index,
        reason: 'declared-byte-length-mismatch',
        declaredBytes: tensor.bytes,
        expectedBytes,
      };
    }
    const decodedBytes = decodedBase64ByteLength(tensor.base64);
    if (decodedBytes === undefined) {
      return { ok: false, status: 400, error: 'invalid-boundary-tensor', index, reason: 'invalid-base64' };
    }
    if (decodedBytes !== expectedBytes) {
      return {
        ok: false,
        status: 400,
        error: 'invalid-boundary-tensor',
        index,
        reason: 'encoded-byte-length-mismatch',
        decodedBytes,
        expectedBytes,
      };
    }
    tensorBytes += expectedBytes;
  }
  return { ok: true, tensorBytes };
}

function validateResultPayload(body) {
  if (body.status !== 'pass') {
    return { ok: false, status: 400, error: 'invalid-result-payload', reason: 'status-must-be-pass' };
  }
  if (body.relayOwner !== 'coordinator' || body.directWorkerNetworking !== false) {
    return { ok: false, status: 400, error: 'invalid-result-payload', reason: 'relay-semantics-mismatch' };
  }
  if (!Array.isArray(body.logitsShape) || body.logitsShape.length !== 3) {
    return { ok: false, status: 400, error: 'invalid-result-payload', reason: 'invalid-logits-shape' };
  }
  if (!body.logitsShape.every((dimension) => Number.isSafeInteger(dimension) && dimension > 0) || body.logitsShape[0] !== 1) {
    return { ok: false, status: 400, error: 'invalid-result-payload', reason: 'invalid-logits-shape' };
  }
  const vocabSize = body.logitsShape[2];
  if (!Number.isSafeInteger(body.top1TokenId) || body.top1TokenId < 0 || body.top1TokenId >= vocabSize) {
    return { ok: false, status: 400, error: 'invalid-result-payload', reason: 'top1-token-out-of-range' };
  }
  if (typeof body.top1Logit !== 'number' || !Number.isFinite(body.top1Logit)) {
    return { ok: false, status: 400, error: 'invalid-result-payload', reason: 'top1-logit-must-be-finite' };
  }
  if (!Array.isArray(body.inputTokenIds) || body.inputTokenIds.length === 0
    || !body.inputTokenIds.every((tokenId) => Number.isSafeInteger(tokenId) && tokenId >= 0)) {
    return { ok: false, status: 400, error: 'invalid-result-payload', reason: 'invalid-input-token-ids' };
  }
  if (!Number.isSafeInteger(body.boundaryBytes) || body.boundaryBytes <= 0) {
    return { ok: false, status: 400, error: 'invalid-result-payload', reason: 'invalid-boundary-bytes' };
  }
  return { ok: true };
}

function parseCookies(raw) {
  const cookies = new Map();
  for (const item of String(raw ?? '').split(';')) {
    const separator = item.indexOf('=');
    if (separator <= 0) continue;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (key) cookies.set(key, value);
  }
  return cookies;
}

function hashProfileProbeToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function profileProbeForRequest(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let token = cookies.get(PROFILE_PROBE_COOKIE);
  let newlyIssued = false;
  if (!token) {
    token = randomUUID();
    newlyIssued = true;
    // HttpOnly is intentional: browser code does not get to manufacture the
    // proof value. SameSite=Strict keeps this localhost-only diagnostic probe
    // out of cross-site requests.
    res.setHeader(
      'Set-Cookie',
      `${PROFILE_PROBE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
    );
  }
  return { hash: hashProfileProbeToken(token), newlyIssued };
}

function profileProbeHashFromRequest(req) {
  const token = parseCookies(req.headers.cookie).get(PROFILE_PROBE_COOKIE);
  return token ? hashProfileProbeToken(token) : undefined;
}

function workerIdentityForRequest(state, req, workerId, allowedRoles) {
  const worker = state.workers.get(workerId);
  if (!worker) {
    return { ok: false, status: 409, error: 'worker-must-register-first', workerId };
  }
  if (!allowedRoles.includes(worker.role)) {
    return {
      ok: false,
      status: 409,
      error: 'worker-role-mismatch',
      workerId,
      role: worker.role,
      expectedRoles: allowedRoles,
    };
  }
  const requestProbeHash = profileProbeHashFromRequest(req);
  if (!requestProbeHash) {
    return { ok: false, status: 409, error: 'profile-probe-cookie-required', workerId };
  }
  if (requestProbeHash !== worker.profileProbeHash) {
    return {
      ok: false,
      status: 409,
      error: 'profile-probe-cookie-mismatch',
      workerId,
      generation: worker.generation,
    };
  }
  worker.profileProbeConfirmed = true;
  return {
    ok: true,
    identity: {
      workerId: worker.workerId,
      role: worker.role,
      generation: worker.generation,
      profileProbeHash: worker.profileProbeHash,
    },
  };
}

async function statSafe(path) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function serveFile(urlPath, res) {
  let base = ROOT;
  let pathname = urlPath;
  if (pathname === '/') pathname = '/index.html';
  if (pathname.startsWith('/models/')) {
    if (!MODELS_DIR) {
      res.writeHead(404).end('MODELS_DIR is not configured');
      return;
    }
    base = MODELS_DIR;
    pathname = pathname.slice('/models/'.length);
  }

  const target = normalize(join(base, pathname));
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  if (!(resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + '/'))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let file = resolvedTarget;
  if ((await statSafe(file))?.isDirectory()) file = join(file, 'index.html');
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': pathname.startsWith('/models/') ? 'public, max-age=3600' : 'no-store',
  });
  res.end(body);
}

function resolveProfileIsolation(state, runId, resultBody, segment1Identity) {
  const checkpoint = state.checkpoints.get(runId);
  if (!checkpoint) {
    return { ok: false, status: 409, error: 'checkpoint-not-ready-for-profile-isolation' };
  }
  const sourceIdentity = checkpoint.sourceWorkerIdentity;
  if (!sourceIdentity) {
    return { ok: false, status: 409, error: 'checkpoint-source-identity-missing' };
  }
  if (sourceIdentity.profileProbeHash === segment1Identity.profileProbeHash) {
    return {
      ok: false,
      status: 409,
      error: 'profile-isolation-not-proven',
      reason: 'segment0 and segment1 writes used the same Coordinator-issued browser profile probe',
      sourceWorkerId: sourceIdentity.workerId,
      segment1WorkerId: segment1Identity.workerId,
    };
  }
  if (String(resultBody.segment0WorkerId ?? sourceIdentity.workerId) !== sourceIdentity.workerId) {
    return {
      ok: false,
      status: 409,
      error: 'result-source-worker-mismatch',
      sourceWorkerId: sourceIdentity.workerId,
      reportedSourceWorkerId: resultBody.segment0WorkerId,
    };
  }
  return {
    ok: true,
    evidence: {
      method: 'coordinator-issued-http-only-cookie',
      confirmed: true,
      sourceWorkerId: sourceIdentity.workerId,
      sourceWorkerGeneration: sourceIdentity.generation,
      segment1WorkerId: segment1Identity.workerId,
      segment1WorkerGeneration: segment1Identity.generation,
      sourceProfileProbeHash: sourceIdentity.profileProbeHash,
      segment1ProfileProbeHash: segment1Identity.profileProbeHash,
    },
  };
}

export function createSplitHarnessServer({ state = createCoordinatorState() } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/api/health') {
        json(res, 200, {
          ok: true,
          workers: state.workers.size,
          checkpoints: state.checkpoints.size,
          results: state.results.size,
          directWorkerNetworking: false,
          browserProfileIsolationEnforced: true,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/workers/register') {
        const body = await readJson(req);
        const workerId = safeWorkerId(String(body.workerId ?? ''));
        const role = String(body.role ?? '');
        if (!['segment0', 'segment1', 'standby'].includes(role)) {
          json(res, 400, { ok: false, error: 'invalid worker role' });
          return;
        }
        const profileProbe = profileProbeForRequest(req, res);
        const previous = state.workers.get(workerId);
        const generation = Number(previous?.generation ?? 0) + 1;
        state.workers.set(workerId, {
          workerId,
          role,
          generation,
          registeredAt: Date.now(),
          adapter: body.adapter ?? null,
          profileProbeHash: profileProbe.hash,
          profileProbeConfirmed: !profileProbe.newlyIssued,
        });
        json(res, 201, {
          ok: true,
          workerId,
          role,
          generation,
          profileProbeAssigned: profileProbe.newlyIssued,
          profileProbeConfirmed: !profileProbe.newlyIssued,
          profileProbeHash: profileProbe.hash,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/workers') {
        json(res, 200, { workers: [...state.workers.values()] });
        return;
      }

      const checkpointMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/checkpoint$/);
      if (checkpointMatch) {
        const runId = safeRunId(checkpointMatch[1]);
        if (req.method === 'POST') {
          const body = await readJson(req);
          const validatedTensors = validateBoundaryTensors(body.tensors);
          if (!validatedTensors.ok) {
            json(res, validatedTensors.status, validatedTensors);
            return;
          }
          const sourceWorkerId = safeWorkerId(String(body.sourceWorkerId ?? ''));
          const sourceIdentity = workerIdentityForRequest(state, req, sourceWorkerId, ['segment0']);
          if (!sourceIdentity.ok) {
            json(res, sourceIdentity.status, sourceIdentity);
            return;
          }
          const record = {
            ...body,
            sourceWorkerId,
            sourceWorkerIdentity: sourceIdentity.identity,
            runId,
            relayOwner: 'coordinator',
            directWorkerNetworking: false,
            storedAt: Date.now(),
          };
          state.checkpoints.set(runId, record);
          json(res, 201, {
            ok: true,
            runId,
            relayOwner: 'coordinator',
            sourceWorkerGeneration: sourceIdentity.identity.generation,
            profileProbeConfirmed: true,
            tensorBytes: validatedTensors.tensorBytes,
          });
          return;
        }
        if (req.method === 'GET') {
          const record = state.checkpoints.get(runId);
          if (!record) {
            json(res, 404, { ok: false, error: 'checkpoint-not-ready' });
            return;
          }
          json(res, 200, record);
          return;
        }
      }

      const resultMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/result$/);
      if (resultMatch) {
        const runId = safeRunId(resultMatch[1]);
        if (req.method === 'POST') {
          const body = await readJson(req);
          const segment1WorkerId = safeWorkerId(String(body.segment1WorkerId ?? ''));
          const segment1Identity = workerIdentityForRequest(
            state,
            req,
            segment1WorkerId,
            ['segment1', 'standby'],
          );
          if (!segment1Identity.ok) {
            json(res, segment1Identity.status, segment1Identity);
            return;
          }
          const validatedResult = validateResultPayload(body);
          if (!validatedResult.ok) {
            json(res, validatedResult.status, validatedResult);
            return;
          }
          const isolation = resolveProfileIsolation(state, runId, body, segment1Identity.identity);
          if (!isolation.ok) {
            json(res, isolation.status, isolation);
            return;
          }
          const record = {
            ...body,
            runId,
            segment1WorkerIdentity: segment1Identity.identity,
            profileIsolationConfirmed: true,
            profileIsolationEvidence: isolation.evidence,
            storedAt: Date.now(),
          };
          state.results.set(runId, record);
          json(res, 201, {
            ok: true,
            runId,
            profileIsolationConfirmed: true,
            profileIsolationEvidence: isolation.evidence,
          });
          return;
        }
        if (req.method === 'GET') {
          const record = state.results.get(runId);
          if (!record) {
            json(res, 404, { ok: false, error: 'result-not-ready' });
            return;
          }
          json(res, 200, record);
          return;
        }
      }

      if (url.pathname === '/worker-peer/direct') {
        json(res, 403, {
          ok: false,
          rejected: true,
          reason: 'direct worker-to-worker networking is forbidden; relay through Coordinator',
        });
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        await serveFile(url.pathname, res);
        return;
      }
      res.writeHead(404).end('not found');
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  return { server, state };
}

export async function listenSplitHarness({ port = DEFAULT_PORT } = {}) {
  const { server, state } = createSplitHarnessServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, '127.0.0.1', resolvePromise);
  });
  return { server, state, port };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  listenSplitHarness().then(({ port }) => {
    console.log(`Unzen real two-browser split harness: http://127.0.0.1:${port}`);
    console.log(`MODELS_DIR=${MODELS_DIR ?? '(not configured)'}`);
    console.log('Browser profile isolation: enforced via Coordinator-issued HttpOnly probe cookie');
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
