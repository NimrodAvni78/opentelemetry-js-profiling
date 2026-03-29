import * as pprof from '@datadog/pprof';
import { Profile } from 'pprof-format';
import { RawProfileData } from './raw-profile-data';

export interface HeapProfilerOptions {
  samplingIntervalBytes?: number;
  stackDepth?: number;
  sourceMapper?: pprof.SourceMapper;
}

export class HeapProfiler {
  private readonly intervalBytes: number;
  private readonly stackDepth: number;
  private readonly sourceMapper: pprof.SourceMapper | undefined;
  private started = false;
  private lastCollectTime: Date | null = null;

  constructor(options: HeapProfilerOptions = {}) {
    this.intervalBytes = options.samplingIntervalBytes ?? 524288; // 512KB
    this.stackDepth = options.stackDepth ?? 64;
    this.sourceMapper = options.sourceMapper;
  }

  start(): void {
    if (this.started) return;
    pprof.heap.start(this.intervalBytes, this.stackDepth);
    this.started = true;
    this.lastCollectTime = new Date();
  }

  collect(): RawProfileData {
    if (!this.started) throw new Error('Heap profiler not started');
    const startedAt = this.lastCollectTime!;
    const profile = pprof.heap.profile(undefined, this.sourceMapper) as unknown as Profile;
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
