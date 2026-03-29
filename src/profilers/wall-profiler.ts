import * as pprof from '@datadog/pprof';
import { Profile } from 'pprof-format';
import { RawProfileData } from './raw-profile-data';

export interface WallProfilerOptions {
  samplingIntervalMicros?: number;
  traceCorrelation?: boolean;
  spanAttributeKeys?: string[];
  sourceMapper?: pprof.SourceMapper;
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
  private readonly sourceMapper: pprof.SourceMapper | undefined;
  private started = false;
  private lastCollectTime: Date | null = null;
  private otelApi: OtelApi | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private origContextWith: ((...args: any[]) => any) | null = null;

  constructor(options: WallProfilerOptions = {}) {
    this.intervalMicros = options.samplingIntervalMicros ?? 10000; // 100Hz
    this.traceCorrelation = options.traceCorrelation ?? false;
    this.spanAttributeKeys = options.spanAttributeKeys ?? [];
    this.sourceMapper = options.sourceMapper;
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
      sourceMapper: this.sourceMapper,
    });

    if (withContexts) {
      this.patchOtelContextWith();
    }

    this.started = true;
    this.lastCollectTime = new Date();
  }

  /**
   * Wraps @opentelemetry/api context.with() to propagate trace context to pprof.
   * This works with ANY context manager (AsyncHooksContextManager,
   * AsyncLocalStorageContextManager, etc.) because context.with() is the
   * universal entry point for all OTel context changes.
   */
  private patchOtelContextWith(): void {
    const otelApi = this.otelApi!;
    const contextApi = otelApi.context;
    this.origContextWith = contextApi.with.bind(contextApi);
    const origWith = this.origContextWith!;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contextApi.with = function (context: any, fn: any, thisArg?: any, ...args: any[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrappedFn = function (this: unknown, ...fnArgs: any[]) {
        const prevContext = pprof.time.getContext();
        const span = otelApi.trace.getSpan(context);
        if (span) {
          const ctx = span.spanContext();
          pprof.time.setContext({ traceId: ctx.traceId, spanId: ctx.spanId, span });
        } else {
          pprof.time.setContext(undefined);
        }
        try {
          return fn.call(this, ...fnArgs);
        } finally {
          pprof.time.setContext(prevContext);
        }
      };
      return origWith(context, wrappedFn, thisArg, ...args);
    };
  }

  private unpatchOtelContextWith(): void {
    if (this.origContextWith && this.otelApi) {
      this.otelApi.context.with = this.origContextWith;
      this.origContextWith = null;
    }
  }

  collect(): RawProfileData {
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

  stop(): RawProfileData | null {
    if (!this.started) return null;
    const startedAt = this.lastCollectTime!;

    this.unpatchOtelContextWith();

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
