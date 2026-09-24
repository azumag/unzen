export const DEFAULT_ENDPOINT_WEBGPU_DIAGNOSTIC_PORT = 8793;

export function resolveEndpointWebgpuDiagnosticPort(
  rawPort,
  defaultPort = DEFAULT_ENDPOINT_WEBGPU_DIAGNOSTIC_PORT,
) {
  const port = Number(rawPort ?? defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must resolve to an integer between 1 and 65535');
  }
  return port;
}
