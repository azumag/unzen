import geometryModule from './wasm-fixtures/segment-geometry.wasm';

const I32_MAX = 0x7fffffff;

if (!(geometryModule instanceof WebAssembly.Module)) {
  throw new TypeError('segment-geometry-wasm: imported .wasm is not a WebAssembly.Module');
}

const instance = await WebAssembly.instantiate(geometryModule);
const check = instance.exports.check;

if (typeof check !== 'function') {
  throw new TypeError('segment-geometry-wasm: expected exported check function');
}

const REASONS = {
  1: 'segment-index-sequence',
  2: 'non-contiguous-layer-start',
  3: 'reversed-layer-range',
  4: 'layer-outside-model',
  5: 'segments-incomplete',
};

function inI32Domain(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= I32_MAX;
}

function validateGeometry(payload) {
  if (!payload || typeof payload !== 'object') {
    return { status: 'invalid', reason: 'invalid-payload', wasmCalled: false };
  }

  const { totalLayers, segments } = payload;
  if (!inI32Domain(totalLayers) || totalLayers < 1) {
    return { status: 'invalid', reason: 'numeric-domain', wasmCalled: false };
  }
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > I32_MAX) {
    return { status: 'invalid', reason: 'empty-or-invalid-segments', wasmCalled: false };
  }

  const normalized = [];
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') {
      return { status: 'invalid', reason: 'invalid-segment-shape', wasmCalled: false };
    }
    const { index, layerStart, layerEnd } = segment;
    if (![index, layerStart, layerEnd].every(inI32Domain)) {
      return { status: 'invalid', reason: 'numeric-domain', wasmCalled: false };
    }
    normalized.push({ index, layerStart, layerEnd });
  }

  normalized.sort((left, right) => left.index - right.index);
  let expectedLayerStart = 0;
  for (let position = 0; position < normalized.length; position += 1) {
    const segment = normalized[position];
    const reasonCode = check(
      segment.index,
      position,
      segment.layerStart,
      expectedLayerStart,
      segment.layerEnd,
      totalLayers,
      position === normalized.length - 1 ? 1 : 0,
    );
    if (reasonCode !== 0) {
      return {
        status: 'invalid',
        reasonCode,
        reason: REASONS[reasonCode] ?? 'unknown-wasm-reason',
        wasmCalled: true,
      };
    }
    expectedLayerStart = segment.layerEnd + 1;
  }

  return { status: 'valid', reasonCode: 0, reason: null, wasmCalled: true };
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response('POST required', { status: 405 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return Response.json(
        { status: 'invalid', reason: 'invalid-json', wasmCalled: false },
        { status: 400 },
      );
    }

    return Response.json({
      ...validateGeometry(payload),
      moduleType: 'WebAssembly.Module',
    });
  },
};
