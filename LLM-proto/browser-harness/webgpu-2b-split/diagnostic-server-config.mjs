export const DEFAULT_DIAGNOSTIC_SERVER_PORT = 8793;

export function resolveDiagnosticServerPort(rawPort) {
  const source = rawPort === undefined ? DEFAULT_DIAGNOSTIC_SERVER_PORT : rawPort;
  if (typeof source === 'string' && source.length === 0) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const port = Number(source);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535: ${String(source)}`);
  }
  return port;
}
