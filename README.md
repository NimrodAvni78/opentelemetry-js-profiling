# @opentelemetry/profiling-node

OpenTelemetry continuous profiling SDK for Node.js. Collects wall-clock and heap profiles using [`@datadog/pprof`](https://github.com/nicovak/dd-pprof) and exports them in OTLP format via gRPC.

## Features

- **Wall-clock profiling** — samples JS stacks at regular intervals (default 100Hz), capturing both on-CPU and idle time
- **Heap profiling** — samples memory allocations to identify where memory is being consumed
- **OTLP gRPC export** — sends profiles to any OTLP-compatible backend (OTel Collector, Grafana, etc.)
- **OTel environment variables** — respects `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_PROFILES_EXPORTER`, etc.
- **Console exporter** — for local debugging

## Installation

```bash
npm install @opentelemetry/profiling-node
```

## Quick Start

```typescript
import { ProfilingProvider } from '@opentelemetry/profiling-node';

const provider = new ProfilingProvider({
  serviceName: 'my-service',
});

provider.start();

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

Prints a summary of each profile to stdout. Useful for debugging.

```typescript
import { ConsoleProfileExporter } from '@opentelemetry/profiling-node';

const exporter = new ConsoleProfileExporter();
```

### Custom

Implement the `ProfileExporter` interface:

```typescript
import { ProfileExporter, ProfileData, ResourceAttributes } from '@opentelemetry/profiling-node';

class MyExporter implements ProfileExporter {
  async export(data: ProfileData, resource: ResourceAttributes): Promise<void> {
    // data.profile  — pprof Profile object
    // data.profileType — 'wall' | 'heap'
    // data.startedAt / data.stoppedAt — collection window
  }

  async shutdown(): Promise<void> {
    // cleanup
  }
}
```

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

When Node.js hits an `await`, the call stack is unwound — there's no stack to sample. This means a function like `await db.query()` appears as `(idle)` samples, not as samples attributed to `db.query`.

## Examples

See the [`examples/`](./examples) directory:

- [`basic.ts`](./examples/basic.ts) — minimal setup with console exporter
- [`otlp-collector.ts`](./examples/otlp-collector.ts) — export to an OTel Collector

## API Reference

### `ProfilingProvider`

| Method | Description |
|--------|-------------|
| `new ProfilingProvider(config?)` | Create a provider with optional config |
| `start()` | Start profilers and begin periodic collection |
| `stop(): Promise<void>` | Stop profilers, flush final profiles, shutdown exporter |

### `ProfileData`

| Field | Type | Description |
|-------|------|-------------|
| `profile` | `Profile` | pprof Profile object |
| `profileType` | `'wall' \| 'heap'` | Type of profile |
| `startedAt` | `Date` | Start of collection window |
| `stoppedAt` | `Date` | End of collection window |

### `ProfileExporter`

| Method | Description |
|--------|-------------|
| `export(data, resource): Promise<void>` | Export a single profile |
| `shutdown(): Promise<void>` | Clean up resources |

## License

Apache-2.0
