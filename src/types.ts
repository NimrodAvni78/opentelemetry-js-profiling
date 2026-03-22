import { Profile } from 'pprof-format';

export type ResourceAttributes = Record<string, string | number | boolean>;

export interface ProfileData {
  profile: Profile;
  profileType: 'wall' | 'heap';
  startedAt: Date;
  stoppedAt: Date;
}

export interface ProfileExporter {
  export(data: ProfileData, resource: ResourceAttributes): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ProfilingProviderConfig {
  resource?: ResourceAttributes;
  serviceName?: string;
  exporter?: ProfileExporter;
  wallProfilingEnabled?: boolean;
  heapProfilingEnabled?: boolean;
  collectionIntervalMs?: number;
  wallSamplingIntervalMicros?: number;
  heapSamplingIntervalBytes?: number;
  heapStackDepth?: number;
}
