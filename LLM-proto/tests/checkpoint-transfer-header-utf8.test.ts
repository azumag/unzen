import { describe, expect, it } from 'vitest';
import { deserializeCheckpointPayload } from '../src/checkpoint-transfer-measurement.js';

function createFrameWithMalformedHeaderUtf8(): Uint8Array {
  const header = {
    requestId: 'checkpoint-X-request',
    segmentIndex: 0,
    metadata: {
      shape: [1, 1, 1],
      dtype: 'int8',
      sequenceLength: 1,
      timestamp: 0,
    },
  };
  const encodedHeader = new TextEncoder().encode(JSON.stringify(header));
  const markerIndex = encodedHeader.indexOf('X'.charCodeAt(0));
  if (markerIndex < 0) {
    throw new Error('test fixture marker was not encoded');
  }

  encodedHeader[markerIndex] = 0xff;
  const frame = new Uint8Array(4 + encodedHeader.byteLength + 1);
  new DataView(frame.buffer).setUint32(0, encodedHeader.byteLength, true);
  frame.set(encodedHeader, 4);
  frame[frame.length - 1] = 7;
  return frame;
}

describe('checkpoint serialized-header UTF-8 integrity', () => {
  it('rejects malformed UTF-8 even when replacement decoding would produce valid JSON', () => {
    const frame = createFrameWithMalformedHeaderUtf8();
    const headerLength = new DataView(frame.buffer).getUint32(0, true);
    const malformedHeader = frame.slice(4, 4 + headerLength);

    expect(() => JSON.parse(new TextDecoder().decode(malformedHeader))).not.toThrow();
    expect(() => deserializeCheckpointPayload(frame)).toThrow(
      'serialized checkpoint header must be valid JSON',
    );
  });
});
