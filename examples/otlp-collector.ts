/**
 * Export profiles to an OpenTelemetry Collector via OTLP gRPC.
 *
 * Prerequisites:
 *   1. Run an OTel Collector with a profiles pipeline:
 *
 *      docker run --rm -p 4317:4317 \
 *        -v $(pwd)/examples/collector-config.yaml:/etc/otelcol/config.yaml \
 *        --feature-gates=service.enabledFeatureGates=telemetry.enableOTLPProfiles \
 *        otel/opentelemetry-collector-contrib:latest
 *
 *   2. Run this example:
 *      npx ts-node examples/otlp-collector.ts
 */
import {
  ProfilingProvider,
  OtlpGrpcProfileExporter,
  ConsoleProfileExporter,
} from '../src';

async function main(): Promise<void> {
  const provider = new ProfilingProvider({
    serviceName: 'otlp-example',
    resource: {
      'deployment.environment': 'development',
      'service.version': '0.1.0',
    },
    exporters: [
      new OtlpGrpcProfileExporter({ endpoint: 'http://localhost:4317' }),
      new ConsoleProfileExporter({ verbosity: 'basic' }),
    ],
    collectionIntervalMs: 10_000,
  });

  await provider.start();
  console.log('Profiling started — exporting to collector at localhost:4317');
  console.log('Press Ctrl+C to stop.');

  // Simulate work
  function doWork(): void {
    const arr: number[] = [];
    for (let i = 0; i < 1_000_000; i++) {
      arr.push(Math.sqrt(i));
    }
  }

  const interval = setInterval(doWork, 500);

  async function shutdown(): Promise<void> {
    clearInterval(interval);
    console.log('\nShutting down...');
    await provider.stop();
    console.log('Profiles flushed. Done.');
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main();
