import { describe, it, expect } from 'vitest';
import { Profile } from 'pprof-format';
import {
  DictionaryBuilder,
  pprofToOtlp,
  buildRequest,
  encodeRequest,
} from '../src/convert/pprof-to-otlp';
import { opentelemetry } from '../src/generated/otlp';

const ExportProfilesServiceRequest =
  opentelemetry.proto.collector.profiles.v1development.ExportProfilesServiceRequest;

function makePprofProfile(opts: {
  strings?: string[];
  functions?: {
    id: number;
    name: number;
    systemName: number;
    filename: number;
    startLine: number;
  }[];
  locations?: { id: number; address: number; line: { functionId: number; line: number }[] }[];
  samples?: {
    locationId: number[];
    value: number[];
    label: { key: number; str?: number; num?: number; numUnit?: number }[];
  }[];
  sampleType?: { type: number; unit: number }[];
  periodType?: { type: number; unit: number };
  period?: number;
  timeNanos?: number;
  durationNanos?: number;
}): Profile {
  const strings = opts.strings ?? [''];
  return {
    stringTable: { strings },
    function: (opts.functions ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      systemName: f.systemName,
      filename: f.filename,
      startLine: f.startLine,
    })),
    location: (opts.locations ?? []).map((l) => ({
      id: l.id,
      address: l.address,
      mappingId: 0,
      line: l.line.map((ln) => ({ functionId: ln.functionId, line: ln.line })),
      isFolded: false,
    })),
    sample: (opts.samples ?? []).map((s) => ({
      locationId: s.locationId,
      value: s.value,
      label: s.label.map((l) => ({
        key: l.key,
        str: l.str ?? 0,
        num: l.num ?? 0,
        numUnit: l.numUnit ?? 0,
      })),
    })),
    sampleType: (opts.sampleType ?? []).map((st) => ({ type: st.type, unit: st.unit })),
    periodType: opts.periodType ?? null,
    period: opts.period ?? 0,
    timeNanos: opts.timeNanos ?? 0,
    durationNanos: opts.durationNanos ?? 0,
    mapping: [],
    dropFrames: 0,
    keepFrames: 0,
    comment: [],
    defaultSampleType: 0,
  } as unknown as Profile;
}

describe('DictionaryBuilder', () => {
  it('interns strings with deduplication', () => {
    const dict = new DictionaryBuilder();
    const a = dict.internString('hello');
    const b = dict.internString('world');
    const c = dict.internString('hello');
    expect(a).toBe(c);
    expect(a).not.toBe(b);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const built = dict.build() as any;
    expect(built.stringTable).toEqual(['', 'hello', 'world']);
  });

  it('empty string is always index 0', () => {
    const dict = new DictionaryBuilder();
    expect(dict.internString('')).toBe(0);
    expect(dict.internString('')).toBe(0);
  });

  it('deduplicates functions by content', () => {
    const dict = new DictionaryBuilder();
    const nameIdx = dict.internString('foo');
    const fn = {
      nameStrindex: nameIdx,
      systemNameStrindex: 0,
      filenameStrindex: 0,
      startLine: 10,
    };
    const a = dict.addFunction(fn);
    const b = dict.addFunction(fn);
    expect(a).toBe(b);

    const different = { ...fn, startLine: 20 };
    const c = dict.addFunction(different);
    expect(c).not.toBe(a);
  });

  it('deduplicates locations by content', () => {
    const dict = new DictionaryBuilder();
    const loc = { address: 0x1000, line: [{ functionIndex: 1, line: 42 }] };
    const a = dict.addLocation(loc);
    const b = dict.addLocation(loc);
    expect(a).toBe(b);

    const different = { address: 0x2000, line: [{ functionIndex: 1, line: 42 }] };
    expect(dict.addLocation(different)).not.toBe(a);
  });

  it('deduplicates stacks by location indices', () => {
    const dict = new DictionaryBuilder();
    const a = dict.addStack([1, 2, 3]);
    const b = dict.addStack([1, 2, 3]);
    const c = dict.addStack([3, 2, 1]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('deduplicates links by trace/span ID', () => {
    const dict = new DictionaryBuilder();
    const traceId = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const spanId = Buffer.from('0123456789abcdef', 'hex');
    const a = dict.addLink(traceId, spanId);
    const b = dict.addLink(traceId, spanId);
    expect(a).toBe(b);

    const differentSpan = Buffer.from('fedcba9876543210', 'hex');
    expect(dict.addLink(traceId, differentSpan)).not.toBe(a);
  });

  it('deduplicates attributes by key+value+unit', () => {
    const dict = new DictionaryBuilder();
    const attr = { keyStrindex: 1, value: { stringValue: 'v' }, unitStrindex: 0 };
    const a = dict.addAttribute(attr);
    const b = dict.addAttribute(attr);
    expect(a).toBe(b);

    const different = { keyStrindex: 1, value: { stringValue: 'other' }, unitStrindex: 0 };
    expect(dict.addAttribute(different)).not.toBe(a);
  });

  it('all tables start with a zero-value entry', () => {
    const dict = new DictionaryBuilder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const built = dict.build() as any;
    expect(built.stringTable[0]).toBe('');
    expect(built.functionTable[0]).toEqual({});
    expect(built.locationTable[0]).toEqual({});
    expect(built.mappingTable[0]).toEqual({});
    expect(built.linkTable[0]).toEqual({});
    expect(built.attributeTable[0]).toEqual({});
    expect(built.stackTable[0]).toEqual({});
  });
});

describe('pprofToOtlp', () => {
  it('converts functions, locations, and samples', () => {
    const pprof = makePprofProfile({
      strings: ['', 'cpu', 'nanoseconds', 'main', '', 'app.js'],
      functions: [{ id: 1, name: 3, systemName: 4, filename: 5, startLine: 10 }],
      locations: [{ id: 1, address: 0x1000, line: [{ functionId: 1, line: 42 }] }],
      samples: [{ locationId: [1], value: [1000], label: [] }],
      sampleType: [{ type: 1, unit: 2 }],
      periodType: { type: 1, unit: 2 },
      period: 10000,
      timeNanos: 1000000000,
      durationNanos: 5000000000,
    });

    const dict = new DictionaryBuilder();
    const profileId = Buffer.alloc(16, 0xab);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = pprofToOtlp(pprof, profileId, [1, 2], dict) as any;

    expect(result.profileId).toBe(profileId);
    expect(result.timeUnixNano).toBe(1000000000);
    expect(result.durationNano).toBe(5000000000);
    expect(result.period).toBe(10000);
    expect(result.attributeIndices).toEqual([1, 2]);
    expect(result.sampleType).toBeDefined();
    expect(result.sample).toHaveLength(1);
    expect(result.sample[0].values).toEqual([1000]);
    expect(result.sample[0].stackIndex).toBeGreaterThan(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const built = dict.build() as any;
    expect(built.stringTable).toContain('main');
    expect(built.stringTable).toContain('app.js');
    expect(built.functionTable.length).toBeGreaterThan(1);
    expect(built.locationTable.length).toBeGreaterThan(1);
    expect(built.stackTable.length).toBeGreaterThan(1);
  });

  it('converts labels to OTLP attributes', () => {
    const pprof = makePprofProfile({
      strings: ['', 'thread', 'main-thread'],
      samples: [{ locationId: [], value: [1], label: [{ key: 1, str: 2 }] }],
    });

    const dict = new DictionaryBuilder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = pprofToOtlp(pprof, Buffer.alloc(16), [], dict) as any;

    expect(result.sample[0].attributeIndices.length).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const built = dict.build() as any;
    const attr = built.attributeTable[result.sample[0].attributeIndices[0]];
    expect(built.stringTable[attr.keyStrindex]).toBe('thread');
    expect(attr.value.stringValue).toBe('main-thread');
  });

  it('converts numeric labels to int attributes', () => {
    const pprof = makePprofProfile({
      strings: ['', 'bytes'],
      samples: [{ locationId: [], value: [1], label: [{ key: 1, num: 4096 }] }],
    });

    const dict = new DictionaryBuilder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = pprofToOtlp(pprof, Buffer.alloc(16), [], dict) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const built = dict.build() as any;
    const attr = built.attributeTable[result.sample[0].attributeIndices[0]];
    expect(attr.value.intValue).toBe(4096);
  });

  it('extracts trace_id/span_id labels into the Link table', () => {
    const traceId = 'aabbccdd11223344aabbccdd11223344';
    const spanId = 'eeff001122334455';

    const pprof = makePprofProfile({
      strings: ['', 'trace_id', traceId, 'span_id', spanId],
      samples: [
        {
          locationId: [],
          value: [1],
          label: [
            { key: 1, str: 2 },
            { key: 3, str: 4 },
          ],
        },
      ],
    });

    const dict = new DictionaryBuilder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = pprofToOtlp(pprof, Buffer.alloc(16), [], dict) as any;

    expect(result.sample[0].attributeIndices).toHaveLength(0);
    expect(result.sample[0].linkIndex).toBeGreaterThan(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const built = dict.build() as any;
    const link = built.linkTable[result.sample[0].linkIndex];
    expect(Buffer.from(link.traceId).toString('hex')).toBe(traceId);
    expect(Buffer.from(link.spanId).toString('hex')).toBe(spanId);
  });

  it('keeps other labels alongside trace correlation', () => {
    const pprof = makePprofProfile({
      strings: ['', 'trace_id', 'a'.repeat(32), 'span_id', 'b'.repeat(16), 'http.route', '/api'],
      samples: [
        {
          locationId: [],
          value: [1],
          label: [
            { key: 1, str: 2 },
            { key: 3, str: 4 },
            { key: 5, str: 6 },
          ],
        },
      ],
    });

    const dict = new DictionaryBuilder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = pprofToOtlp(pprof, Buffer.alloc(16), [], dict) as any;

    expect(result.sample[0].linkIndex).toBeGreaterThan(0);
    expect(result.sample[0].attributeIndices).toHaveLength(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const built = dict.build() as any;
    const attr = built.attributeTable[result.sample[0].attributeIndices[0]];
    expect(built.stringTable[attr.keyStrindex]).toBe('http.route');
    expect(attr.value.stringValue).toBe('/api');
  });

  it('handles empty profile gracefully', () => {
    const pprof = makePprofProfile({});
    const dict = new DictionaryBuilder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = pprofToOtlp(pprof, Buffer.alloc(16), [], dict) as any;
    expect(result.sample).toEqual([]);
    expect(result.sampleType).toBeUndefined();
  });

  it('deduplicates shared stacks across samples', () => {
    const pprof = makePprofProfile({
      strings: ['', 'cpu', 'ns', 'main', '', 'app.js'],
      functions: [{ id: 1, name: 3, systemName: 4, filename: 5, startLine: 1 }],
      locations: [{ id: 1, address: 100, line: [{ functionId: 1, line: 10 }] }],
      samples: [
        { locationId: [1], value: [100], label: [] },
        { locationId: [1], value: [200], label: [] },
        { locationId: [1], value: [300], label: [] },
      ],
    });

    const dict = new DictionaryBuilder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = pprofToOtlp(pprof, Buffer.alloc(16), [], dict) as any;

    expect(result.sample).toHaveLength(3);
    const stackIdx = result.sample[0].stackIndex;
    expect(result.sample[1].stackIndex).toBe(stackIdx);
    expect(result.sample[2].stackIndex).toBe(stackIdx);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const built = dict.build() as any;
    expect(built.functionTable).toHaveLength(2);
    expect(built.locationTable).toHaveLength(2);
    expect(built.stackTable).toHaveLength(2);
  });
});

describe('buildRequest', () => {
  it('wraps pprof profiles in OTLP request structure', () => {
    const pprof = makePprofProfile({
      strings: ['', 'wall', 'microseconds', 'doWork', '', 'index.ts'],
      functions: [{ id: 1, name: 3, systemName: 4, filename: 5, startLine: 1 }],
      locations: [{ id: 1, address: 0, line: [{ functionId: 1, line: 5 }] }],
      samples: [{ locationId: [1], value: [500], label: [] }],
      sampleType: [{ type: 1, unit: 2 }],
    });

    const request = buildRequest(
      [{ profile: pprof, profileType: 'wall', startedAt: new Date(), stoppedAt: new Date() }],
      { 'service.name': 'test-svc', 'deployment.environment': 'prod' },
    );

    expect(request.resourceProfiles).toHaveLength(1);
    const rp = request.resourceProfiles?.[0];
    expect(rp?.scopeProfiles).toHaveLength(1);
    expect(rp?.scopeProfiles?.[0]?.scope?.name).toBe('@opentelemetry/profiling-node');

    const attrs = rp?.resource?.attributes ?? [];
    expect(attrs.find((a) => a.key === 'service.name')?.value?.stringValue).toBe('test-svc');
    expect(attrs.find((a) => a.key === 'deployment.environment')?.value?.stringValue).toBe('prod');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dict = request.dictionary as any;
    expect(dict.stringTable).toContain('doWork');
    expect(dict.stringTable).toContain('index.ts');
  });

  it('handles boolean and numeric resource attributes', () => {
    const pprof = makePprofProfile({
      samples: [{ locationId: [], value: [1], label: [] }],
    });

    const request = buildRequest(
      [{ profile: pprof, profileType: 'heap', startedAt: new Date(), stoppedAt: new Date() }],
      { 'service.name': 'test', count: 42, enabled: true },
    );

    const attrs = request.resourceProfiles?.[0]?.resource?.attributes ?? [];
    expect(attrs.find((a) => a.key === 'count')?.value?.intValue).toBe(42);
    expect(attrs.find((a) => a.key === 'enabled')?.value?.boolValue).toBe(true);
  });
});

describe('encodeRequest', () => {
  it('produces valid protobuf that roundtrips', () => {
    const pprof = makePprofProfile({
      strings: ['', 'cpu', 'ns', 'fn1', '', 'f.js'],
      functions: [{ id: 1, name: 3, systemName: 4, filename: 5, startLine: 0 }],
      locations: [{ id: 1, address: 0, line: [{ functionId: 1, line: 1 }] }],
      samples: [{ locationId: [1], value: [100], label: [] }],
      sampleType: [{ type: 1, unit: 2 }],
    });

    const request = buildRequest(
      [{ profile: pprof, profileType: 'wall', startedAt: new Date(), stoppedAt: new Date() }],
      { 'service.name': 'roundtrip' },
    );

    const encoded = encodeRequest(request);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = ExportProfilesServiceRequest.decode(encoded);
    expect(decoded.resourceProfiles).toHaveLength(1);

    const dict = decoded.dictionary;
    expect(dict).toBeDefined();
    if (!dict) return;

    expect(dict.stringTable).toContain('fn1');
    expect(dict.stringTable).toContain('f.js');

    const rAttrs = decoded.resourceProfiles[0].resource?.attributes ?? [];
    expect(rAttrs.find((a) => a.key === 'service.name')?.value?.stringValue).toBe('roundtrip');
  });

  it('preserves trace correlation links through encode/decode', () => {
    const traceId = 'aabbccdd11223344aabbccdd11223344';
    const spanId = 'eeff001122334455';

    const pprof = makePprofProfile({
      strings: ['', 'trace_id', traceId, 'span_id', spanId],
      samples: [
        {
          locationId: [],
          value: [1],
          label: [
            { key: 1, str: 2 },
            { key: 3, str: 4 },
          ],
        },
      ],
    });

    const request = buildRequest(
      [{ profile: pprof, profileType: 'wall', startedAt: new Date(), stoppedAt: new Date() }],
      { 'service.name': 'link-test' },
    );

    const encoded = encodeRequest(request);
    const decoded = ExportProfilesServiceRequest.decode(encoded);

    const linkTable = decoded.dictionary?.linkTable ?? [];
    const nonEmpty = linkTable.filter(
      (l) => l.traceId && l.traceId.length > 0 && !l.traceId.every((b) => b === 0),
    );
    expect(nonEmpty.length).toBe(1);
    expect(Buffer.from(nonEmpty[0].traceId).toString('hex')).toBe(traceId);
    expect(Buffer.from(nonEmpty[0].spanId).toString('hex')).toBe(spanId);
  });
});
