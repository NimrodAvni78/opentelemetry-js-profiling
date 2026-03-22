import * as pprof from '@datadog/pprof';
import { Profile } from 'pprof-format';
import { ProfileData } from '../types';

export interface HeapProfilerOptions {
  samplingIntervalBytes?: number;
  stackDepth?: number;
}

export class HeapProfiler {
  private readonly intervalBytes: number;
  private readonly stackDepth: number;
  private started = false;
  private lastCollectTime: Date | null = null;

  constructor(options: HeapProfilerOptions = {}) {
    this.intervalBytes = options.samplingIntervalBytes ?? 524288; // 512KB
    this.stackDepth = options.stackDepth ?? 64;
  }

  start(): void {
    if (this.started) return;
    pprof.heap.start(this.intervalBytes, this.stackDepth);
    this.started = true;
    this.lastCollectTime = new Date();
  }

  collect(): ProfileData {
    if (!this.started) throw new Error('Heap profiler not started');
    const startedAt = this.lastCollectTime!;
    const profile = pprof.heap.profile() as unknown as Profile;
    this.lastCollectTime = new Date();
    return {
      profile,
      profileType: 'heap',
      startedAt,
      stoppedAt: this.lastCollectTime,
    };
  }

  stop(): void {
    if (!this.started) return;
    pprof.heap.stop();
    this.started = false;
  }
}
