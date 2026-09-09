# Endpoint post-stage RSS capture configuration

Status: **diagnostic-only / #223 feasibility support**. This configuration contract does not choose an endpoint architecture, physical-artifact layout, execution-tile count, production memory budget, cache/runtime/dispatcher behavior, or artifact policy.

`tools/capture_endpoint_poststage_webgpu_process_rss.mjs` launches an isolated harness server and Chrome instance, captures the Chrome process-tree RSS envelope, and on macOS also samples `/usr/bin/footprint` at selected milestones. Because the resulting JSON is used as diagnostic evidence, malformed timing or port configuration must fail before the harness server or Chrome is started.

## Invocation

From `LLM-proto/`:

```bash
node tools/capture_endpoint_poststage_webgpu_process_rss.mjs \
  /absolute/path/to/endpoint-poststage-webgpu-data \
  /tmp/endpoint-poststage-webgpu-process-rss.json
```

Two positional arguments are required: the prepared browser harness data directory and the output JSON path.

## Environment overrides

| variable | default | accepted value |
|---|---:|---|
| `CHROME_BINARY` | platform default | non-empty executable path/name; empty values fall back to the platform default |
| `UNZEN_HARNESS_PORT` | `8796` | integer `1..65535` |
| `UNZEN_CDP_PORT` | `9336` | integer `1..65535`, distinct from `UNZEN_HARNESS_PORT` |
| `UNZEN_RSS_SAMPLE_INTERVAL_MS` | `100` | positive safe integer milliseconds |
| `UNZEN_RSS_POST_REPORT_SETTLE_MS` | `5000` | non-negative safe integer milliseconds |
| `UNZEN_RSS_POST_TEARDOWN_SETTLE_MS` | `30000` | non-negative safe integer milliseconds |
| `UNZEN_RSS_TIMEOUT_MS` | `120000` | positive safe integer milliseconds |

Numeric overrides are parsed before `runCapture()` performs its platform check, creates a Chrome profile, checks sockets, starts the harness server, or launches Chrome. Empty numeric strings, `NaN`, fractional numbers, negative values, zero where a positive value is required, out-of-range ports, and a harness/CDP port collision are rejected synchronously with the offending variable name in the error.

A zero settle duration is intentionally valid for the two settle-window settings. It means "take the immediate milestone only"; it does not promote that observation into reclamation evidence.

Example with explicit non-default ports and a shorter sampling interval:

```bash
UNZEN_HARNESS_PORT=18796 \
UNZEN_CDP_PORT=19336 \
UNZEN_RSS_SAMPLE_INTERVAL_MS=50 \
UNZEN_RSS_POST_REPORT_SETTLE_MS=5000 \
UNZEN_RSS_POST_TEARDOWN_SETTLE_MS=30000 \
UNZEN_RSS_TIMEOUT_MS=180000 \
node tools/capture_endpoint_poststage_webgpu_process_rss.mjs \
  /absolute/path/to/endpoint-poststage-webgpu-data \
  /tmp/endpoint-poststage-webgpu-process-rss.json
```

## Evidence boundary

Passing configuration validation establishes only that the capture parameters are structurally usable. The resulting RSS and macOS physical-footprint observations remain diagnostic OS metrics. They do not directly measure ORT/WebGPU/Metal allocations, prove allocator reclamation, establish a leak-free provider contract, or approve a production browser resource profile. The broader interpretation and committed measurements remain documented in [`endpoint-layout-candidate-probe.md`](./endpoint-layout-candidate-probe.md).
