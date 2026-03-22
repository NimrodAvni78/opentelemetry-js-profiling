import * as pprof from '@datadog/pprof';
import { Profile } from 'pprof-format';
import { ProfileData } from '../types';

export interface WallProfilerOptions {
  samplingIntervalMicros?: number;
}

export class WallProfiler {
  private readonly intervalMicros: number;
  private started = false;
  private lastCollectTime: Date | null = null;

  constructor(options: WallProfilerOptions = {}) {
    this.intervalMicros = options.samplingIntervalMicros ?? 10000; // 100Hz
  }

  start(): void {
    if (this.started) return;
    pprof.time.start({
      intervalMicros: this.intervalMicros,
      lineNumbers: false,
      withContexts: false,
      workaroundV8Bug: true,
      collectCpuTime: false,
    });
    this.started = true;
    this.lastCollectTime = new Date();
  }

  collect(): ProfileData {
    if (!this.started) throw new Error('Wall profiler not started');
    const startedAt = this.lastCollectTime!;
    const rawProfile = pprof.time.stop(true); // restart=true
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
    const rawProfile = pprof.time.stop(false); // restart=false
    this.started = false;
    return {
      profile: rawProfile as unknown as Profile,
      profileType: 'wall',
      startedAt,
      stoppedAt: new Date(),
    };
  }
}
