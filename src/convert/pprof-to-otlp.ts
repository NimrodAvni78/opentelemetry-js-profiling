import { randomBytes } from 'node:crypto';
import { Profile } from 'pprof-format';
import { IExportProfilesServiceRequest, ResourceAttributes } from '../types';
import { opentelemetry } from '../generated/otlp';
import { RawProfileData } from '../profilers/raw-profile-data';

const ExportProfilesServiceRequest =
  opentelemetry.proto.collector.profiles.v1development.ExportProfilesServiceRequest;

type Numeric = number | bigint;

function toNumber(val: Numeric | null | undefined): number {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'bigint') return Number(val);
  return Number(val) || 0;
}

function hexToBytes(hex: string, length: number): Buffer {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < Math.min(hex.length / 2, length); i++) {
    buf[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

export class DictionaryBuilder {
  private _strings: string[] = [''];
  private _stringIndex = new Map<string, number>([['', 0]]);
  private _functions: object[] = [{}];
  private _functionKeyToIndex = new Map<string, number>();
  private _locations: object[] = [{}];
  private _locationKeyToIndex = new Map<string, number>();
  private _mappings: object[] = [{}];
  private _links: object[] = [{}];
  private _linkKeyToIndex = new Map<string, number>();
  private _attributes: object[] = [{}];
  private _attributeKeyToIndex = new Map<string, number>();
  private _stacks: object[] = [{}];
  private _stackKeyToIndex = new Map<string, number>();

  internString(str: string): number {
    if (str == null) str = '';
    let idx = this._stringIndex.get(str);
    if (idx !== undefined) return idx;
    idx = this._strings.length;
    this._strings.push(str);
    this._stringIndex.set(str, idx);
    return idx;
  }

  addFunction(fn: {
    nameStrindex: number;
    systemNameStrindex: number;
    filenameStrindex: number;
    startLine: number;
  }): number {
    const key = `${fn.nameStrindex}:${fn.systemNameStrindex}:${fn.filenameStrindex}:${fn.startLine}`;
    let idx = this._functionKeyToIndex.get(key);
    if (idx !== undefined) return idx;
    idx = this._functions.length;
    this._functionKeyToIndex.set(key, idx);
    this._functions.push(fn);
    return idx;
  }

  addLocation(loc: {
    mappingIndex?: number;
    address?: number;
    line?: { functionIndex: number; line: number }[];
  }): number {
    const linesKey = (loc.line || []).map((l) => `${l.functionIndex}:${l.line}`).join(';');
    const key = `${loc.mappingIndex || 0}:${loc.address || 0}:${linesKey}`;
    let idx = this._locationKeyToIndex.get(key);
    if (idx !== undefined) return idx;
    idx = this._locations.length;
    this._locationKeyToIndex.set(key, idx);
    this._locations.push(loc);
    return idx;
  }

  addAttribute(attr: { keyStrindex: number; value: object; unitStrindex?: number }): number {
    const valStr = JSON.stringify(attr.value || {});
    const key = `${attr.keyStrindex}:${valStr}:${attr.unitStrindex || 0}`;
    let idx = this._attributeKeyToIndex.get(key);
    if (idx !== undefined) return idx;
    idx = this._attributes.length;
    this._attributeKeyToIndex.set(key, idx);
    this._attributes.push(attr);
    return idx;
  }

  addLink(traceId: Buffer, spanId: Buffer): number {
    const key = `${traceId.toString('hex')}:${spanId.toString('hex')}`;
    let idx = this._linkKeyToIndex.get(key);
    if (idx !== undefined) return idx;
    idx = this._links.length;
    this._linkKeyToIndex.set(key, idx);
    this._links.push({ traceId, spanId });
    return idx;
  }

  addStack(locationIndices: number[]): number {
    const key = locationIndices.join(',');
    let idx = this._stackKeyToIndex.get(key);
    if (idx !== undefined) return idx;
    idx = this._stacks.length;
    this._stackKeyToIndex.set(key, idx);
    this._stacks.push({ locationIndices });
    return idx;
  }

  build(): object {
    return {
      mappingTable: this._mappings,
      locationTable: this._locations,
      functionTable: this._functions,
      linkTable: this._links,
      stringTable: this._strings,
      attributeTable: this._attributes,
      stackTable: this._stacks,
    };
  }
}

export function pprofToOtlp(
  pprof: Profile,
  profileId: Buffer,
  profileAttributeIndices: number[],
  dict: DictionaryBuilder,
): object {
  const pprofStrings = pprof.stringTable.strings;
  const pprofStrToDict = pprofStrings.map((s) => dict.internString(s));

  function mapStr(pprofIdx: Numeric): number {
    const idx = toNumber(pprofIdx);
    return idx >= 0 && idx < pprofStrToDict.length ? pprofStrToDict[idx] : 0;
  }

  // Functions
  const pprofFuncIdToDict = new Map<number, number>();
  for (const fn of pprof.function) {
    const dictIdx = dict.addFunction({
      nameStrindex: mapStr(fn.name),
      systemNameStrindex: mapStr(fn.systemName),
      filenameStrindex: mapStr(fn.filename),
      startLine: toNumber(fn.startLine),
    });
    pprofFuncIdToDict.set(toNumber(fn.id), dictIdx);
  }

  // Locations
  const pprofLocIdToDict = new Map<number, number>();
  for (const loc of pprof.location) {
    const line = loc.line.map((ln) => ({
      functionIndex: pprofFuncIdToDict.get(toNumber(ln.functionId)) ?? 0,
      line: toNumber(ln.line),
    }));
    pprofLocIdToDict.set(
      toNumber(loc.id),
      dict.addLocation({ address: toNumber(loc.address), line }),
    );
  }

  // Samples — detect trace_id/span_id labels for Link table
  const otlpSamples: object[] = [];
  for (const sample of pprof.sample) {
    const locationIndices = sample.locationId.map((id) => pprofLocIdToDict.get(toNumber(id)) ?? 0);
    const stackIndex = locationIndices.length > 0 ? dict.addStack(locationIndices) : 0;

    const attributeIndices: number[] = [];
    let traceIdHex: string | null = null;
    let spanIdHex: string | null = null;

    for (const label of sample.label) {
      const keyStr = pprofStrings[toNumber(label.key)] || '';

      // Extract trace correlation labels for the Link table
      if (keyStr === 'trace_id' && label.str && toNumber(label.str) !== 0) {
        traceIdHex = pprofStrings[toNumber(label.str)] || null;
        continue;
      }
      if (keyStr === 'span_id' && label.str && toNumber(label.str) !== 0) {
        spanIdHex = pprofStrings[toNumber(label.str)] || null;
        continue;
      }

      // Regular attribute
      const keyStrindex = mapStr(label.key);
      const value =
        label.str && toNumber(label.str) !== 0
          ? { stringValue: pprofStrings[toNumber(label.str)] || '' }
          : { intValue: toNumber(label.num) };
      const unitStrindex =
        label.numUnit && toNumber(label.numUnit) !== 0 ? mapStr(label.numUnit) : 0;
      attributeIndices.push(dict.addAttribute({ keyStrindex, value, unitStrindex }));
    }

    // Build link if trace correlation data present
    let linkIndex = 0;
    if (traceIdHex && spanIdHex) {
      const traceIdBytes = hexToBytes(traceIdHex, 16);
      const spanIdBytes = hexToBytes(spanIdHex, 8);
      linkIndex = dict.addLink(traceIdBytes, spanIdBytes);
    }

    otlpSamples.push({
      stackIndex,
      values: sample.value.map((v) => toNumber(v)),
      attributeIndices,
      linkIndex: linkIndex || undefined,
      timestampsUnixNano: [toNumber(pprof.timeNanos)],
    });
  }

  const pprofSampleTypes = pprof.sampleType;
  const sampleType =
    pprofSampleTypes.length > 0
      ? {
          typeStrindex: mapStr(pprofSampleTypes[0].type),
          unitStrindex: mapStr(pprofSampleTypes[0].unit),
        }
      : undefined;

  const periodType = pprof.periodType
    ? { typeStrindex: mapStr(pprof.periodType.type), unitStrindex: mapStr(pprof.periodType.unit) }
    : undefined;

  return {
    sampleType,
    sample: otlpSamples,
    timeUnixNano: toNumber(pprof.timeNanos),
    durationNano: toNumber(pprof.durationNanos),
    periodType,
    period: toNumber(pprof.period),
    profileId,
    attributeIndices: profileAttributeIndices,
  };
}

export function buildRequest(
  rawProfiles: RawProfileData[],
  resource: ResourceAttributes,
): IExportProfilesServiceRequest {
  const dict = new DictionaryBuilder();
  const otlpProfiles: object[] = [];

  for (const { profile, profileType } of rawProfiles) {
    const profileId = randomBytes(16);

    const rawAttrs = [
      { key: 'profiler.type', value: { stringValue: profileType } },
      ...Object.entries(resource).map(([k, v]) => ({
        key: k,
        value: typeof v === 'number' ? { intValue: v } : { stringValue: String(v) },
      })),
    ];
    const profileAttributeIndices = rawAttrs.map((attr) =>
      dict.addAttribute({
        keyStrindex: dict.internString(attr.key),
        value: attr.value,
        unitStrindex: 0,
      }),
    );

    otlpProfiles.push(pprofToOtlp(profile, profileId, profileAttributeIndices, dict));
  }

  const resourceAttrs = Object.entries(resource).map(([key, value]) => ({
    key,
    value:
      typeof value === 'number'
        ? { intValue: value }
        : typeof value === 'boolean'
          ? { boolValue: value }
          : { stringValue: String(value) },
  }));

  return {
    resourceProfiles: [
      {
        resource: { attributes: resourceAttrs },
        scopeProfiles: [
          {
            scope: { name: '@opentelemetry/profiling-node' },
            profiles: otlpProfiles,
          },
        ],
      },
    ],
    dictionary: dict.build(),
  };
}

export function encodeRequest(request: IExportProfilesServiceRequest): Uint8Array {
  return ExportProfilesServiceRequest.encode(request).finish();
}
