import { ProfileExporter, ProfilingProviderConfig, ResourceAttributes } from './types';
import { resolveResource } from './resource';
import { WallProfiler } from './profilers/wall-profiler';
import { HeapProfiler } from './profilers/heap-profiler';
import { OtlpGrpcProfileExporter } from './exporters/otlp-grpc-exporter';
import { ConsoleProfileExporter } from './exporters/console-exporter';

const DEFAULT_COLLECTION_INTERVAL_MS = 10000;

export class ProfilingProvider {
  private readonly resource: ResourceAttributes;
  private readonly exporter: ProfileExporter;
  private wallProfiler: WallProfiler | null = null;
  private heapProfiler: HeapProfiler | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly config: ProfilingProviderConfig;

  constructor(config: ProfilingProviderConfig = {}) {
    this.config = config;
    this.resource = resolveResource({
      serviceName: config.serviceName,
      attributes: config.resource,
    });
    this.exporter = config.exporter ?? this.resolveExporter();
  }

  private resolveExporter(): ProfileExporter {
    const env = process.env.OTEL_PROFILES_EXPORTER ?? 'otlp';
    switch (env) {
      case 'console':
        return new ConsoleProfileExporter();
      case 'none':
        return { export: async () => {}, shutdown: async () => {} };
      case 'otlp':
      case 'otlp_grpc':
      default:
        return new OtlpGrpcProfileExporter();
    }
  }

  start(): void {
    if (this.timer) return;

    const wallEnabled = this.config.wallProfilingEnabled ?? true;
    const heapEnabled = this.config.heapProfilingEnabled ?? true;

    if (wallEnabled) {
      this.wallProfiler = new WallProfiler({
        samplingIntervalMicros: this.config.wallSamplingIntervalMicros,
        traceCorrelation: this.config.traceCorrelation,
        spanAttributeKeys: this.config.spanAttributeKeys,
      });
      this.wallProfiler.start();
    }

    if (heapEnabled) {
      this.heapProfiler = new HeapProfiler({
        samplingIntervalBytes: this.config.heapSamplingIntervalBytes,
        stackDepth: this.config.heapStackDepth,
      });
      this.heapProfiler.start();
    }

    const intervalMs = this.config.collectionIntervalMs ?? DEFAULT_COLLECTION_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.collectAndExport();
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Final collection
    await this.collectAndExport();

    if (this.wallProfiler) {
      const final = this.wallProfiler.stop();
      if (final) {
        await this.exporter.export(final, this.resource).catch(() => {});
      }
      this.wallProfiler = null;
    }

    if (this.heapProfiler) {
      this.heapProfiler.stop();
      this.heapProfiler = null;
    }

    await this.exporter.shutdown();
  }

  private async collectAndExport(): Promise<void> {
    const exports: Promise<void>[] = [];

    if (this.wallProfiler) {
      try {
        const data = this.wallProfiler.collect();
        exports.push(this.exporter.export(data, this.resource).catch(() => {}));
      } catch {
        /* profiler not started */
      }
    }

    if (this.heapProfiler) {
      try {
        const data = this.heapProfiler.collect();
        exports.push(this.exporter.export(data, this.resource).catch(() => {}));
      } catch {
        /* profiler not started */
      }
    }

    await Promise.all(exports);
  }
}
