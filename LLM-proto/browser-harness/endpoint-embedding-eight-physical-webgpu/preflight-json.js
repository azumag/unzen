const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function parseEndpointEmbeddingEightPhysicalPreflightBytes(bytes) {
  return JSON.parse(utf8Decoder.decode(bytes));
}
