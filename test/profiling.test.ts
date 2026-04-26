import { describe, it, expect, afterEach } from 'vitest';
import { trace, context } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { ProfilingProvider } from '../src/profiling-provider';
import { encodeRequest } from '../src/convert/pprof-to-otlp';
import { opentelemetry } from '../src/generated/otlp';
import type { ProfileData, ProfileExporter } from '../src/types';

const ExportProfilesServiceRequest =
  opentelemetry.proto.collector.profiles.v1development.ExportProfilesServiceRequest;

class CollectingExporter implements ProfileExporter {
  profiles: ProfileData[] = [];
  async export(data: ProfileData): Promise<void> {
    this.profiles.push(data);
  }
  async shutdown(): Promise<void> {}
}

function burnCpu(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    Math.sqrt(Math.random());
  }
}

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

function getStrings(data: ProfileData): string[] {
  return (data.request.dictionary?.stringTable as string[]) ?? [];
}

function getFunctionNames(data: ProfileData): string[] {
  const strings = getStrings(data);
  const functions = data.request.dictionary?.functionTable ?? [];
  return functions.map((fn) => {
    const idx = fn?.nameStrindex;
    return typeof idx === 'number' ? (strings[idx] ?? '') : '';
  });
}

describe('ProfilingProvider', () => {
  afterEach(() => {
    trace.disable();
    context.disable();
  });

  it('collects wall profiles with application function names', async () => {
    const exporter = new CollectingExporter();
    const provider = new ProfilingProvider({
      serviceName: 'test-service',
      exporters: [exporter],
      collectionIntervalMs: 60_000,
      heapProfilingEnabled: false,
    });

    await provider.start();
    burnCpu(500);
    await provider.stop();

    const wallProfiles = exporter.profiles.filter((p) => p.profileType === 'wall');
    expect(wallProfiles.length).toBeGreaterThanOrEqual(1);

    const combined = wallProfiles.flatMap((p) => getFunctionNames(p));
    expect(combined).toContain('burnCpu');
  });

  it('collects heap profiles with allocation function names', async () => {
    const exporter = new CollectingExporter();
    const provider = new ProfilingProvider({
      serviceName: 'test-service',
      exporters: [exporter],
      collectionIntervalMs: 60_000,
      wallProfilingEnabled: false,
      heapSamplingIntervalBytes: 256,
    });

    await provider.start();
    const _data = allocateMemory();
    await provider.stop();

    const heapProfiles = exporter.profiles.filter((p) => p.profileType === 'heap');
    expect(heapProfiles.length).toBeGreaterThanOrEqual(1);

    const combined = heapProfiles.flatMap((p) => getFunctionNames(p));
    expect(combined).toContain('allocateMemory');
    expect(_data.length).toBe(50_000);
  });

  it('sets resource attributes from config', async () => {
    const exporter = new CollectingExporter();
    const provider = new ProfilingProvider({
      serviceName: 'my-svc',
      resource: { 'deployment.environment': 'test' },
      exporters: [exporter],
      collectionIntervalMs: 60_000,
      heapProfilingEnabled: false,
    });

    await provider.start();
    burnCpu(200);
    await provider.stop();

    expect(exporter.profiles.length).toBeGreaterThanOrEqual(1);
    const attrs = exporter.profiles[0].request.resourceProfiles?.[0]?.resource?.attributes ?? [];
    const serviceName = attrs.find((a) => a.key === 'service.name');
    const env = attrs.find((a) => a.key === 'deployment.environment');
    const lang = attrs.find((a) => a.key === 'telemetry.sdk.language');
    expect(serviceName?.value?.stringValue).toBe('my-svc');
    expect(env?.value?.stringValue).toBe('test');
    expect(lang?.value?.stringValue).toBe('javascript');
  });

  it('periodic collection flushes profiles at interval', async () => {
    const exporter = new CollectingExporter();
    const provider = new ProfilingProvider({
      serviceName: 'test-service',
      exporters: [exporter],
      collectionIntervalMs: 200,
      heapProfilingEnabled: false,
    });

    await provider.start();
    for (let i = 0; i < 5; i++) {
      burnCpu(100);
      await sleep(100);
    }
    await provider.stop();

    const wallProfiles = exporter.profiles.filter((p) => p.profileType === 'wall');
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

  it('attaches trace_id and span_id in the OTLP Link table', async () => {
    const contextManager = new AsyncLocalStorageContextManager();
    context.setGlobalContextManager(contextManager.enable());

    const spanExporter = new InMemorySpanExporter();
    tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });
    trace.setGlobalTracerProvider(tracerProvider);

    const tracer = trace.getTracer('test');

    const exporter = new CollectingExporter();
    const provider = new ProfilingProvider({
      serviceName: 'test-correlation',
      exporters: [exporter],
      traceCorrelation: true,
      collectionIntervalMs: 60_000,
      heapProfilingEnabled: false,
    });

    await provider.start();

    let capturedTraceId = '';
    tracer.startActiveSpan('test-span', (span) => {
      capturedTraceId = span.spanContext().traceId;
      burnCpu(500);
      span.end();
    });

    await provider.stop();

    const wallProfiles = exporter.profiles.filter((p) => p.profileType === 'wall');
    expect(wallProfiles.length).toBeGreaterThanOrEqual(1);

    const linkTable = wallProfiles[0].request.dictionary?.linkTable ?? [];
    const nonEmptyLinks = linkTable.filter(
      (link) => link.traceId && link.traceId.length > 0 && !link.traceId.every((b) => b === 0),
    );
    expect(nonEmptyLinks.length).toBeGreaterThanOrEqual(1);

    const firstLink = nonEmptyLinks[0];
    expect(firstLink).toBeDefined();
    if (!firstLink?.traceId) return;

    const traceIdHex = Buffer.from(firstLink.traceId).toString('hex');
    expect(traceIdHex).toBe(capturedTraceId);

    const profile =
      wallProfiles[0].request.resourceProfiles?.[0]?.scopeProfiles?.[0]?.profiles?.[0];
    const samples = profile?.sample ?? [];
    const samplesWithLinks = samples.filter((s) => s.linkIndex && s.linkIndex > 0);
    expect(samplesWithLinks.length).toBeGreaterThan(0);
  });

  it('attaches span attributes as labels when spanAttributeKeys is configured', async () => {
    const contextManager = new AsyncLocalStorageContextManager();
    context.setGlobalContextManager(contextManager.enable());

    const spanExporter = new InMemorySpanExporter();
    tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });
    trace.setGlobalTracerProvider(tracerProvider);

    const tracer = trace.getTracer('test');

    const exporter = new CollectingExporter();
    const provider = new ProfilingProvider({
      serviceName: 'attr-test',
      exporters: [exporter],
      traceCorrelation: true,
      spanAttributeKeys: ['http.route', 'custom.tag'],
      collectionIntervalMs: 60_000,
      heapProfilingEnabled: false,
    });

    await provider.start();

    tracer.startActiveSpan('request', (span) => {
      span.setAttribute('http.route', '/api/users');
      span.setAttribute('custom.tag', 'hello');
      span.setAttribute('ignored.key', 'not-captured');
      burnCpu(500);
      span.end();
    });

    await provider.stop();

    const wallProfiles = exporter.profiles.filter((p) => p.profileType === 'wall');
    expect(wallProfiles.length).toBeGreaterThanOrEqual(1);

    const dict = wallProfiles[0].request.dictionary;
    const strings = (dict?.stringTable as string[]) ?? [];
    const attributes = dict?.attributeTable ?? [];

    let foundRoute = false;
    let foundCustomTag = false;
    let foundIgnored = false;

    for (const attr of attributes) {
      const keyStr = strings[attr?.keyStrindex ?? 0] ?? '';
      const valStr = attr?.value?.stringValue ?? '';
      if (keyStr === 'http.route' && valStr === '/api/users') foundRoute = true;
      if (keyStr === 'custom.tag' && valStr === 'hello') foundCustomTag = true;
      if (keyStr === 'ignored.key') foundIgnored = true;
    }

    expect(foundRoute).toBe(true);
    expect(foundCustomTag).toBe(true);
    expect(foundIgnored).toBe(false);
  });
});

describe('OTLP encoding', () => {
  it('encodes and decodes via protobuf roundtrip', async () => {
    const exporter = new CollectingExporter();
    const provider = new ProfilingProvider({
      serviceName: 'roundtrip-test',
      exporters: [exporter],
      collectionIntervalMs: 60_000,
      heapProfilingEnabled: false,
    });

    await provider.start();
    burnCpu(300);
    await provider.stop();

    const wallProfile = exporter.profiles.find((p) => p.profileType === 'wall');
    expect(wallProfile).toBeDefined();
    if (!wallProfile) return;

    const encoded = encodeRequest(wallProfile.request);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = ExportProfilesServiceRequest.decode(encoded);
    expect(decoded.resourceProfiles).toHaveLength(1);

    const rp = decoded.resourceProfiles[0];
    const scopeProfiles = rp.scopeProfiles;
    expect(scopeProfiles).toHaveLength(1);
    if (!scopeProfiles) return;

    const profiles = scopeProfiles[0].profiles;
    expect(profiles).toHaveLength(1);
    if (!profiles) return;

    const samples = profiles[0].sample;
    expect(samples).toBeDefined();
    if (!samples) return;
    expect(samples.length).toBeGreaterThan(0);

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

    const resourceAttrs = rp.resource?.attributes ?? [];
    const serviceNameAttr = resourceAttrs.find((a) => a.key === 'service.name');
    expect(serviceNameAttr?.value?.stringValue).toBe('roundtrip-test');

    expect(stringTable).toContain('burnCpu');
  });
});
