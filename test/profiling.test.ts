import { describe, it, expect, afterEach } from 'vitest';
import { trace, context } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { ProfilingProvider } from '../src/profiling-provider';
import { buildExportRequest } from '../src/convert/pprof-to-otlp';
import { opentelemetry } from '../src/generated/otlp';
import type { ProfileData, ProfileExporter, ResourceAttributes } from '../src/types';

const ExportProfilesServiceRequest =
  opentelemetry.proto.collector.profiles.v1development.ExportProfilesServiceRequest;

// Collects exported profiles for assertions
class CollectingExporter implements ProfileExporter {
  profiles: { data: ProfileData; resource: ResourceAttributes }[] = [];
  async export(data: ProfileData, resource: ResourceAttributes): Promise<void> {
    this.profiles.push({ data, resource });
  }
  async shutdown(): Promise<void> {}
}

// Burn CPU so the wall profiler has something to sample
function burnCpu(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    Math.sqrt(Math.random());
  }
}

// Allocate memory so the heap profiler has something to sample
function allocateMemory(): string[] {
  const data: string[] = [];
  for (let i = 0; i < 50_000; i++) {
    data.push(`item-${i}-${'x'.repeat(200)}`);
  }
  return data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getProfileStrings(data: ProfileData): string[] {
  return data.profile.stringTable.strings;
}

function getProfileFunctionNames(data: ProfileData): string[] {
  const strings = getProfileStrings(data);
  return data.profile.function.map((fn) => strings[Number(fn.name)] || '');
}

describe('ProfilingProvider', () => {
  afterEach(() => {
    // Reset OTel global state
    trace.disable();
    context.disable();
  });

  it('collects wall profiles with application function names', async () => {
    const exporter = new CollectingExporter();
    const provider = new ProfilingProvider({
      serviceName: 'test-service',
      exporter,
      collectionIntervalMs: 60_000, // don't auto-collect, we'll stop manually
      heapProfilingEnabled: false,
    });

    provider.start();
    burnCpu(500);
    await provider.stop();

    const wallProfiles = exporter.profiles.filter((p) => p.data.profileType === 'wall');
    expect(wallProfiles.length).toBeGreaterThanOrEqual(1);

    const combined = wallProfiles.flatMap((p) => getProfileFunctionNames(p.data));
    expect(combined).toContain('burnCpu');
  });

  it('collects heap profiles with allocation function names', async () => {
    const exporter = new CollectingExporter();
    const provider = new ProfilingProvider({
      serviceName: 'test-service',
      exporter,
      collectionIntervalMs: 60_000,
      wallProfilingEnabled: false,
      heapSamplingIntervalBytes: 256, // sample aggressively
    });

    provider.start();

    // Hold reference so GC doesn't collect before profiling
    const _data = allocateMemory();

    await provider.stop();

    const heapProfiles = exporter.profiles.filter((p) => p.data.profileType === 'heap');
    expect(heapProfiles.length).toBeGreaterThanOrEqual(1);

    const combined = heapProfiles.flatMap((p) => getProfileFunctionNames(p.data));
    expect(combined).toContain('allocateMemory');

    // Prevent optimization from eliding the allocation
    expect(_data.length).toBe(50_000);
  });

  it('sets resource attributes from config and env', async () => {
    const exporter = new CollectingExporter();
    const provider = new ProfilingProvider({
      serviceName: 'my-svc',
      resource: { 'deployment.environment': 'test' },
      exporter,
      collectionIntervalMs: 60_000,
      heapProfilingEnabled: false,
    });

    provider.start();
    burnCpu(200);
    await provider.stop();

    expect(exporter.profiles.length).toBeGreaterThanOrEqual(1);
    const resource = exporter.profiles[0].resource;
    expect(resource['service.name']).toBe('my-svc');
    expect(resource['deployment.environment']).toBe('test');
    expect(resource['telemetry.sdk.language']).toBe('javascript');
  });

  it('periodic collection flushes profiles at interval', async () => {
    const exporter = new CollectingExporter();
    const provider = new ProfilingProvider({
      serviceName: 'test-service',
      exporter,
      collectionIntervalMs: 200,
      heapProfilingEnabled: false,
    });

    provider.start();

    // Burn CPU across multiple collection intervals
    for (let i = 0; i < 5; i++) {
      burnCpu(100);
      await sleep(100);
    }

    await provider.stop();

    // Should have collected at least 2 times during the interval + final flush
    const wallProfiles = exporter.profiles.filter((p) => p.data.profileType === 'wall');
    expect(wallProfiles.length).toBeGreaterThanOrEqual(2);
  });
});

describe('trace correlation', () => {
  let tracerProvider: BasicTracerProvider;

  afterEach(async () => {
    trace.disable();
    context.disable();
    if (tracerProvider) {
      await tracerProvider.shutdown();
    }
  });

  it('attaches trace_id and span_id labels to wall samples inside active spans', async () => {
    // Set up OTel tracing with AsyncLocalStorage context manager
    const contextManager = new AsyncLocalStorageContextManager();
    context.setGlobalContextManager(contextManager.enable());

    const spanExporter = new InMemorySpanExporter();
    tracerProvider = new BasicTracerProvider();
    tracerProvider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));
    tracerProvider.register();

    const tracer = trace.getTracer('test');

    const exporter = new CollectingExporter();
    const provider = new ProfilingProvider({
      serviceName: 'test-correlation',
      exporter,
      traceCorrelation: true,
      collectionIntervalMs: 60_000,
      heapProfilingEnabled: false,
    });

    provider.start();

    // Run work inside an active span
    let capturedTraceId = '';
    tracer.startActiveSpan('test-span', (span) => {
      capturedTraceId = span.spanContext().traceId;
      burnCpu(500);
      span.end();
    });

    await provider.stop();

    const wallProfiles = exporter.profiles.filter((p) => p.data.profileType === 'wall');
    expect(wallProfiles.length).toBeGreaterThanOrEqual(1);

    // Check that at least one sample has trace_id/span_id labels
    let foundCorrelation = false;
    for (const { data } of wallProfiles) {
      const strings = getProfileStrings(data);
      for (const sample of data.profile.sample) {
        for (const label of sample.label) {
          const keyStr = strings[Number(label.key)] || '';
          if (keyStr === 'trace_id') {
            const valStr = strings[Number(label.str)] || '';
            if (valStr === capturedTraceId) {
              foundCorrelation = true;
            }
          }
        }
      }
    }

    expect(foundCorrelation).toBe(true);
  });
});

describe('OTLP encoding', () => {
  it('encodes and decodes a wall profile via protobuf roundtrip', async () => {
    const exporter = new CollectingExporter();
    const provider = new ProfilingProvider({
      serviceName: 'roundtrip-test',
      exporter,
      collectionIntervalMs: 60_000,
      heapProfilingEnabled: false,
    });

    provider.start();
    burnCpu(300);
    await provider.stop();

    const wallProfile = exporter.profiles.find((p) => p.data.profileType === 'wall');
    expect(wallProfile).toBeDefined();
    if (!wallProfile) return;

    const { encoded } = buildExportRequest(
      [{ profile: wallProfile.data.profile, profileType: 'wall' }],
      wallProfile.resource,
    );

    // Encoded should be a non-empty buffer
    expect(encoded.length).toBeGreaterThan(0);

    // Decode it back and verify structure
    const decoded = ExportProfilesServiceRequest.decode(encoded);
    expect(decoded.resourceProfiles).toHaveLength(1);

    const rp = decoded.resourceProfiles[0];
    const scopeProfiles = rp.scopeProfiles;
    expect(scopeProfiles).toHaveLength(1);
    if (!scopeProfiles) return;

    const profiles = scopeProfiles[0].profiles;
    expect(profiles).toHaveLength(1);
    if (!profiles) return;

    const samples = profiles[0].samples;
    expect(samples).toBeDefined();
    if (!samples) return;
    expect(samples.length).toBeGreaterThan(0);

    // Verify dictionary has strings and functions
    const dictionary = decoded.dictionary;
    expect(dictionary).toBeDefined();
    if (!dictionary) return;

    const stringTable = dictionary.stringTable;
    const functionTable = dictionary.functionTable;
    expect(stringTable).toBeDefined();
    expect(functionTable).toBeDefined();
    if (!stringTable || !functionTable) return;

    expect(stringTable.length).toBeGreaterThan(1);
    expect(functionTable.length).toBeGreaterThan(1);

    // Verify resource attributes include service name
    const resourceAttrs = rp.resource?.attributes ?? [];
    const serviceNameAttr = resourceAttrs.find((a) => a.key === 'service.name');
    expect(serviceNameAttr).toBeDefined();
    expect(serviceNameAttr?.value?.stringValue).toBe('roundtrip-test');

    // Verify burnCpu appears in the function table string references
    expect(stringTable).toContain('burnCpu');
  });

  it('encodes trace correlation links in the OTLP Link table', async () => {
    // Set up OTel tracing
    const contextManager = new AsyncLocalStorageContextManager();
    context.setGlobalContextManager(contextManager.enable());

    const spanExporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider();
    tracerProvider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));
    tracerProvider.register();

    const tracer = trace.getTracer('test');

    const exporter = new CollectingExporter();
    const provider = new ProfilingProvider({
      serviceName: 'link-test',
      exporter,
      traceCorrelation: true,
      collectionIntervalMs: 60_000,
      heapProfilingEnabled: false,
    });

    provider.start();

    let capturedTraceId = '';
    tracer.startActiveSpan('link-span', (span) => {
      capturedTraceId = span.spanContext().traceId;
      burnCpu(500);
      span.end();
    });

    await provider.stop();

    const wallProfile = exporter.profiles.find((p) => p.data.profileType === 'wall');
    expect(wallProfile).toBeDefined();
    if (!wallProfile) return;

    const { encoded } = buildExportRequest(
      [{ profile: wallProfile.data.profile, profileType: 'wall' }],
      wallProfile.resource,
    );

    const decoded = ExportProfilesServiceRequest.decode(encoded);
    const linkTable = decoded.dictionary?.linkTable ?? [];

    // Should have at least one non-empty link (index 0 is the zero-value)
    const nonEmptyLinks = linkTable.filter(
      (link) => link.traceId && link.traceId.length > 0 && !link.traceId.every((b) => b === 0),
    );
    expect(nonEmptyLinks.length).toBeGreaterThanOrEqual(1);

    // Verify the trace ID matches
    const firstLink = nonEmptyLinks[0];
    expect(firstLink).toBeDefined();
    if (!firstLink) return;

    expect(firstLink.traceId).toBeDefined();
    if (!firstLink.traceId) return;

    const traceIdHex = Buffer.from(firstLink.traceId).toString('hex');
    expect(traceIdHex).toBe(capturedTraceId);

    // Verify at least one sample references a link
    const rp = decoded.resourceProfiles[0];
    const scopeProfiles = rp.scopeProfiles;
    if (!scopeProfiles) return;
    const profiles = scopeProfiles[0].profiles;
    if (!profiles) return;
    const decodedSamples = profiles[0].samples;
    if (!decodedSamples) return;
    const samplesWithLinks = decodedSamples.filter((s) => s.linkIndex && s.linkIndex > 0);
    expect(samplesWithLinks.length).toBeGreaterThan(0);

    await tracerProvider.shutdown();
    trace.disable();
    context.disable();
  });
});
