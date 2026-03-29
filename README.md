# @opentelemetry/profiling-node

OpenTelemetry continuous profiling SDK for Node.js. Collects wall-clock and heap profiles using [`@datadog/pprof`](https://github.com/nicovak/dd-pprof) and exports them in OTLP format via gRPC.

## Features

- **Wall-clock profiling** — samples JS stacks at regular intervals (default 100Hz), capturing both on-CPU and idle time
- **Heap profiling** — samples memory allocations to identify where memory is being consumed
- **Trace-profile correlation** — links profiling samples to active OTel spans via the OTLP Link table
- **Span attribute extraction** — copies selected span attributes (e.g. `http.route`) onto profiling samples
- **Source map support** — maps compiled JS filenames/lines back to original TypeScript sources
- **OTLP gRPC export** — sends profiles to any OTLP-compatible backend (OTel Collector, Grafana, etc.)
- **OTel environment variables** — respects `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_PROFILES_EXPORTER`, etc.
- **Console exporter** — debug exporter matching the OTel Collector's debug exporter format, with configurable verbosity

## Installation

```bash
npm install @opentelemetry/profiling-node
```

For trace-profile correlation:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-trace-node
```

## Quick Start

```typescript
import { ProfilingProvider } from '@opentelemetry/profiling-node';

const provider = new ProfilingProvider({
  serviceName: 'my-service',
});

await provider.start();

// Your application code...

// On shutdown
await provider.stop();
```

## Configuration

### Programmatic

```typescript
import {
  ProfilingProvider,
  ConsoleProfileExporter,
  OtlpGrpcProfileExporter,
} from '@opentelemetry/profiling-node';

const provider = new ProfilingProvider({
  // Service identification
  serviceName: 'my-service',
  resource: {
    'deployment.environment': 'production',
    'service.version': '1.2.3',
  },

  // Profiler toggles
  wallProfilingEnabled: true,   // default: true
  heapProfilingEnabled: true,   // default: true

  // Collection interval — how often profiles are flushed to the exporter
  collectionIntervalMs: 10_000, // default: 10000 (10s)

  // Wall profiler tuning
  wallSamplingIntervalMicros: 10_000, // default: 10000 (100Hz)

  // Heap profiler tuning
  heapSamplingIntervalBytes: 524_288, // default: 524288 (512KB)
  heapStackDepth: 64,                 // default: 64

  // Trace-profile correlation (requires @opentelemetry/api)
  traceCorrelation: true,

  // Copy these span attributes onto profiling samples
  spanAttributeKeys: ['http.route', 'rpc.method'],

  // Source maps — map compiled JS back to original TypeScript sources
  sourceMapSearchPaths: ['./dist'],

  // Exporter — defaults to OTLP gRPC
  exporter: new OtlpGrpcProfileExporter({
    endpoint: 'http://localhost:4317',
    headers: { 'x-api-key': 'secret' },
  }),
});
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OTEL_SERVICE_NAME` | Service name | `unknown` |
| `OTEL_RESOURCE_ATTRIBUTES` | Comma-separated `key=value` pairs | — |
| `OTEL_PROFILES_EXPORTER` | Exporter: `otlp`, `console`, `none` | `otlp` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP gRPC endpoint | `http://localhost:4317` |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `key=value` headers | — |

Environment variables are overridden by programmatic config.

## Exporters

### OTLP gRPC (default)

Sends profiles to an OTLP-compatible collector via gRPC (HTTP/2 + protobuf). Uses Node's built-in `http2` module — no `@grpc/grpc-js` dependency.

```typescript
import { OtlpGrpcProfileExporter } from '@opentelemetry/profiling-node';

const exporter = new OtlpGrpcProfileExporter({
  endpoint: 'http://localhost:4317',
});
```

### Console

Prints profile summaries to stdout, matching the [OTel Collector debug exporter](https://github.com/open-telemetry/opentelemetry-collector/tree/main/exporter/debugexporter) format. Supports three verbosity levels:

```typescript
import { ConsoleProfileExporter } from '@opentelemetry/profiling-node';

// basic — summary line only
new ConsoleProfileExporter({ verbosity: 'basic' });

// normal (default) — summary + one line per profile with resource/scope context
new ConsoleProfileExporter({ verbosity: 'normal' });

// detailed — full dump: resource attributes, samples, dictionary tables, links
new ConsoleProfileExporter({ verbosity: 'detailed' });
```

### Custom

Implement the `ProfileExporter` interface:

```typescript
import { ProfileExporter, ProfileData } from '@opentelemetry/profiling-node';

class MyExporter implements ProfileExporter {
  async export(data: ProfileData): Promise<void> {
    // data.request   — OTLP ExportProfilesServiceRequest (structured, not encoded)
    // data.profileType — 'wall' | 'heap'
    // data.startedAt / data.stoppedAt — collection window
  }

  async shutdown(): Promise<void> {
    // cleanup
  }
}
```

## Trace-Profile Correlation

When `@opentelemetry/api` is installed and a `TracerProvider` is active, enabling `traceCorrelation` links profiling samples to the spans they were captured in.

```typescript
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ProfilingProvider } from '@opentelemetry/profiling-node';

// Set up tracing first
const tracerProvider = new NodeTracerProvider();
tracerProvider.register();

// Then profiling
const profiling = new ProfilingProvider({
  serviceName: 'my-service',
  traceCorrelation: true,
});
await profiling.start();
```

Each wall-clock sample captured while a span is active gets `trace_id` and `span_id` labels in the pprof output. The OTLP converter maps these into the Link table, so backends can navigate from a trace to the corresponding profile and vice versa.

### Span Attribute Extraction

Use `spanAttributeKeys` to copy specific span attributes onto profiling samples. This enables grouping and filtering profiles by attributes like HTTP route or RPC method.

```typescript
const profiling = new ProfilingProvider({
  traceCorrelation: true,
  spanAttributeKeys: ['http.route', 'rpc.method', 'rpc.service'],
});
```

Attributes are read from the span at **profile collection time**, not when the span is activated. This means attributes set after span creation (e.g. `http.route` set by Express after route matching) are captured correctly.

> **Note**: Span attribute extraction only works for wall-clock profiles. Heap profiles use V8's `AllocationProfiler` which has no per-allocation context capture, so there's no way to know which span was active when a given allocation occurred.

## Using with the OpenTelemetry Collector

Example collector config with a debug exporter:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317

exporters:
  debug:
    verbosity: detailed

service:
  pipelines:
    profiles:
      receivers: [otlp]
      exporters: [debug]
```

> **Note**: The collector must have the `service.enabledFeatureGates=telemetry.enableOTLPProfiles` flag set (or run a version where profiles support is GA).

## How It Works

1. **`@datadog/pprof`** drives the actual sampling — it uses a native addon with `setitimer(SIGALRM)` for wall-clock sampling and V8's `AllocationProfiler` for heap sampling
2. **Collection loop** runs every `collectionIntervalMs` (default 10s), calling `stop(restart=true)` on the wall profiler and `profile()` on the heap profiler
3. **pprof → OTLP conversion** maps pprof's flat ID-based structure into OTLP's dictionary-based format (shared string/function/location/stack tables)
4. **gRPC export** encodes the OTLP `ExportProfilesServiceRequest` as protobuf, frames it with gRPC length-prefixed encoding, and sends via HTTP/2

### Wall-clock vs CPU profiling

The wall profiler samples at regular wall-clock intervals regardless of whether JavaScript is executing. This means:
- On-CPU work (computation) shows as function frames
- Off-CPU time (I/O wait, event loop idle) shows as `(idle)`
- Both are captured, giving a complete picture of where time is spent

### Async stack limitation

When Node.js hits an `await`, the call stack is unwound — there's no stack to sample. This means a function like `await db.query()` appears as `(idle)` samples, not as samples attributed to `db.query`. Enabling `traceCorrelation` helps bridge this gap by attributing idle time to the span that was active.

### Source Maps

When profiling TypeScript or bundled applications, V8 reports function names and filenames from the compiled JS output. Enable `sourceMapSearchPaths` to map these back to original source files:

```typescript
const provider = new ProfilingProvider({
  sourceMapSearchPaths: ['./dist'],
});
await provider.start();
```

The provider scans the specified directories for `.js.map` files at startup. Profiles will then show original filenames and line numbers (e.g. `src/handler.ts:42` instead of `dist/handler.js:120`).

Requires your build to emit source maps (e.g. `"sourceMap": true` in `tsconfig.json`).

## Examples

See the [`examples/`](./examples) directory:

- [`basic.ts`](./examples/basic.ts) — minimal setup with console exporter
- [`otlp-collector.ts`](./examples/otlp-collector.ts) — export to an OTel Collector
- [`source-maps.ts`](./examples/source-maps.ts) — map compiled JS back to TypeScript sources

## API Reference

### `ProfilingProviderConfig`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serviceName` | `string` | `'unknown'` | Service name |
| `resource` | `Record<string, string \| number \| boolean>` | — | Additional resource attributes |
| `exporter` | `ProfileExporter` | OTLP gRPC | Custom exporter instance |
| `traceCorrelation` | `boolean` | `false` | Link samples to active OTel spans |
| `spanAttributeKeys` | `string[]` | `[]` | Span attributes to copy onto samples |
| `wallProfilingEnabled` | `boolean` | `true` | Enable wall-clock profiling |
| `heapProfilingEnabled` | `boolean` | `true` | Enable heap profiling |
| `collectionIntervalMs` | `number` | `10000` | How often profiles are flushed |
| `wallSamplingIntervalMicros` | `number` | `10000` | Wall profiler sampling interval (100Hz) |
| `heapSamplingIntervalBytes` | `number` | `524288` | Heap profiler sampling interval (512KB) |
| `heapStackDepth` | `number` | `64` | Max stack depth for heap samples |
| `sourceMapSearchPaths` | `string[]` | — | Directories to scan for `.js.map` files |

### `ProfilingProvider`

| Method | Description |
|--------|-------------|
| `new ProfilingProvider(config?)` | Create a provider with optional config |
| `start(): Promise<void>` | Start profilers and begin periodic collection |
| `stop(): Promise<void>` | Stop profilers, flush final profiles, shutdown exporter |

### `ProfileData`

| Field | Type | Description |
|-------|------|-------------|
| `request` | `IExportProfilesServiceRequest` | OTLP export request (structured, not encoded) |
| `profileType` | `'wall' \| 'heap'` | Type of profile |
| `startedAt` | `Date` | Start of collection window |
| `stoppedAt` | `Date` | End of collection window |

### `ProfileExporter`

| Method | Description |
|--------|-------------|
| `export(data: ProfileData): Promise<void>` | Export a single profile |
| `shutdown(): Promise<void>` | Clean up resources |

## License

Apache-2.0
