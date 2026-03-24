import { AsyncLocalStorage } from 'node:async_hooks';
import * as pprof from '@datadog/pprof';
import { Profile } from 'pprof-format';
import { ProfileData } from '../types';

export interface WallProfilerOptions {
  samplingIntervalMicros?: number;
  traceCorrelation?: boolean;
  spanAttributeKeys?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OtelApi = any;

function tryLoadOtelApi(): OtelApi | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@opentelemetry/api');
  } catch {
    return null;
  }
}

export class WallProfiler {
  private readonly intervalMicros: number;
  private readonly traceCorrelation: boolean;
  private readonly spanAttributeKeys: string[];
  private started = false;
  private lastCollectTime: Date | null = null;
  private otelApi: OtelApi | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private origRun: ((...args: any[]) => any) | null = null;

  constructor(options: WallProfilerOptions = {}) {
    this.intervalMicros = options.samplingIntervalMicros ?? 10000; // 100Hz
    this.traceCorrelation = options.traceCorrelation ?? false;
    this.spanAttributeKeys = options.spanAttributeKeys ?? [];
  }

  start(): void {
    if (this.started) return;

    if (this.traceCorrelation) {
      this.otelApi = tryLoadOtelApi();
      if (!this.otelApi) {
        console.warn(
          '@opentelemetry/profiling-node: traceCorrelation enabled but @opentelemetry/api not found.',
        );
      }
    }

    const withContexts = this.traceCorrelation && this.otelApi != null;

    pprof.time.start({
      intervalMicros: this.intervalMicros,
      lineNumbers: false,
      withContexts,
      workaroundV8Bug: true,
      collectCpuTime: false,
    });

    if (withContexts) {
      this.patchAsyncLocalStorage();
    }

    this.started = true;
    this.lastCollectTime = new Date();
  }

  private patchAsyncLocalStorage(): void {
    const otelApi = this.otelApi!;
    this.origRun = AsyncLocalStorage.prototype.run;
    const origRun = this.origRun;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    AsyncLocalStorage.prototype.run = function (store: any, callback: any, ...runArgs: any[]) {
      const wrappedCallback = function (
        this: unknown,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...cbArgs: any[]
      ): unknown {
        const span = otelApi.trace.getActiveSpan();
        if (span) {
          const ctx = span.spanContext();
          pprof.time.setContext({ traceId: ctx.traceId, spanId: ctx.spanId, span });
        } else {
          pprof.time.setContext(undefined);
        }
        return callback.apply(this, cbArgs);
      };
      return origRun.call(this, store, wrappedCallback, ...runArgs);
    };
  }

  private unpatchAsyncLocalStorage(): void {
    if (this.origRun) {
      AsyncLocalStorage.prototype.run = this.origRun;
      this.origRun = null;
    }
  }

  collect(): ProfileData {
    if (!this.started) throw new Error('Wall profiler not started');
    const startedAt = this.lastCollectTime!;

    const generateLabels = this.traceCorrelation ? this.buildGenerateLabels() : undefined;
    const rawProfile = pprof.time.stop(true, generateLabels); // restart=true

    this.lastCollectTime = new Date();
    return {
      profile: rawProfile as unknown as Profile,
      profileType: 'wall',
      startedAt,
      stoppedAt: this.lastCollectTime,
    };
  }

  stop(): ProfileData | null {
    if (!this.started) return null;
    const startedAt = this.lastCollectTime!;

    this.unpatchAsyncLocalStorage();

    const generateLabels = this.traceCorrelation ? this.buildGenerateLabels() : undefined;
    const rawProfile = pprof.time.stop(false, generateLabels); // restart=false

    this.started = false;
    return {
      profile: rawProfile as unknown as Profile,
      profileType: 'wall',
      startedAt,
      stoppedAt: new Date(),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildGenerateLabels(): (args: { node: any; context?: any }) => Record<string, any> {
    const attrKeys = this.spanAttributeKeys;
    return ({ context }) => {
      const labels: Record<string, string> = {};
      const ctx = context?.context;
      if (!ctx?.traceId) return labels;

      labels.trace_id = ctx.traceId;
      labels.span_id = ctx.spanId;

      // Read span attributes at collection time (not at context-switch time)
      // so attributes set after span activation (e.g. http.route) are captured
      if (attrKeys.length > 0 && ctx.span?.attributes) {
        for (const key of attrKeys) {
          const val = ctx.span.attributes[key];
          if (val != null) {
            labels[key] = String(val);
          }
        }
      }

      return labels;
    };
  }
}
