import type { opentelemetry } from './generated/otlp';

export type IExportProfilesServiceRequest =
  opentelemetry.proto.collector.profiles.v1development.IExportProfilesServiceRequest;

export type ResourceAttributes = Record<string, string | number | boolean>;

export interface ProfileData {
  profileType: 'wall' | 'heap';
  startedAt: Date;
  stoppedAt: Date;
  request: IExportProfilesServiceRequest;
}

export interface ProfileExporter {
  export(data: ProfileData): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ProfilingProviderConfig {
  resource?: ResourceAttributes;
  serviceName?: string;
  exporter?: ProfileExporter;
  traceCorrelation?: boolean;
  spanAttributeKeys?: string[];
  wallProfilingEnabled?: boolean;
  heapProfilingEnabled?: boolean;
  collectionIntervalMs?: number;
  wallSamplingIntervalMicros?: number;
  heapSamplingIntervalBytes?: number;
  heapStackDepth?: number;
  /** Directories to scan for source maps. Enables mapping compiled JS back to original sources. */
  sourceMapSearchPaths?: string[];
}
