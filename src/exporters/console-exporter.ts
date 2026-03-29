import { ProfileData, ProfileExporter, IExportProfilesServiceRequest } from '../types';
import type { opentelemetry } from '../generated/otlp';

type IProfilesDictionary = opentelemetry.proto.profiles.v1development.IProfilesDictionary;
type IResourceProfiles = opentelemetry.proto.profiles.v1development.IResourceProfiles;
type IScopeProfiles = opentelemetry.proto.profiles.v1development.IScopeProfiles;
type IProfile = opentelemetry.proto.profiles.v1development.IProfile;
type IKeyValue = opentelemetry.proto.common.v1.IKeyValue;
type IAnyValue = opentelemetry.proto.common.v1.IAnyValue;

export type ConsoleExporterVerbosity = 'basic' | 'normal' | 'detailed';

export interface ConsoleExporterConfig {
  verbosity?: ConsoleExporterVerbosity;
}

export class ConsoleProfileExporter implements ProfileExporter {
  private readonly verbosity: ConsoleExporterVerbosity;

  constructor(config: ConsoleExporterConfig = {}) {
    this.verbosity = config.verbosity ?? 'normal';
  }

  async export(data: ProfileData): Promise<void> {
    const rp = data.request.resourceProfiles ?? [];
    const dict = data.request.dictionary ?? undefined;
    const strings = (dict?.stringTable as string[] | undefined) ?? [];
    const sampleCount = this.countSamples(data.request);

    // Basic: summary line only (matches debug exporter zap.Info)
    console.log(`Profiles\tresource profiles: ${rp.length}, sample records: ${sampleCount}`);

    if (this.verbosity === 'basic') return;

    // Normal + Detailed
    const lines: string[] = [];
    for (let ri = 0; ri < rp.length; ri++) {
      const resource = rp[ri];
      const resourceAttrs = this.formatKeyValues(resource.resource?.attributes ?? []);
      const schemaUrl = resource.schemaUrl ? ` [${resource.schemaUrl}]` : '';
      lines.push(`ResourceProfiles #${ri}${schemaUrl}${resourceAttrs}`);

      if (this.verbosity === 'detailed') {
        this.writeResourceDetailed(lines, resource);
      }

      const scopeProfiles = resource.scopeProfiles ?? [];
      for (let si = 0; si < scopeProfiles.length; si++) {
        const scope = scopeProfiles[si];
        const scopeInfo = this.formatScope(scope);
        lines.push(`ScopeProfiles #${si}${scopeInfo}`);

        if (this.verbosity === 'detailed') {
          this.writeScopeDetailed(lines, scope);
        }

        const profiles = scope.profiles ?? [];
        for (let pi = 0; pi < profiles.length; pi++) {
          const profile = profiles[pi];
          const profileSamples = profile.samples ?? [];
          const profileId = this.formatProfileId(profile.profileId);
          const profileAttrs = this.resolveAttributeIndices(
            profile.attributeIndices ?? [],
            dict,
            strings,
          );

          if (this.verbosity === 'normal') {
            lines.push(`${profileId} samples=${profileSamples.length}${profileAttrs}`);
          }

          if (this.verbosity === 'detailed') {
            this.writeProfileDetailed(lines, profile, pi, dict, strings);
          }
        }
      }
    }

    if (this.verbosity === 'detailed') {
      this.writeDictionaryDetailed(lines, dict, strings);
    }

    console.log(lines.join('\n'));
  }

  async shutdown(): Promise<void> {}

  private countSamples(request: IExportProfilesServiceRequest): number {
    let count = 0;
    for (const rp of request.resourceProfiles ?? []) {
      for (const sp of rp.scopeProfiles ?? []) {
        for (const p of sp.profiles ?? []) {
          count += (p.samples ?? []).length;
        }
      }
    }
    return count;
  }

  private formatAnyValue(v: IAnyValue | null | undefined): string {
    if (!v) return '';
    return String(v.stringValue ?? v.intValue ?? v.boolValue ?? v.doubleValue ?? '');
  }

  private formatKeyValues(attrs: IKeyValue[]): string {
    if (attrs.length === 0) return '';
    const parts = attrs.map((a) => `${a.key}=${this.formatAnyValue(a.value)}`);
    return ' ' + parts.join(' ');
  }

  private formatScope(scope: IScopeProfiles): string {
    const name = scope.scope?.name ?? '';
    const version = scope.scope?.version;
    const schemaUrl = scope.schemaUrl;
    let s = ` ${name}`;
    if (version) s += `@${version}`;
    if (schemaUrl) s += ` [${schemaUrl}]`;
    return s;
  }

  private formatProfileId(id: Uint8Array | null | undefined): string {
    if (!id || id.length === 0) return '(no-id)';
    return Buffer.from(id).toString('hex');
  }

  private resolveAttributeIndices(
    indices: number[],
    dict: IProfilesDictionary | undefined,
    strings: string[],
  ): string {
    if (indices.length === 0 || !dict) return '';
    const attrs = dict.attributeTable ?? [];
    const parts: string[] = [];
    for (const idx of indices) {
      const attr = attrs[idx];
      if (!attr) continue;
      const key = strings[attr.keyStrindex ?? 0] ?? '';
      const val = this.formatAnyValue(attr.value);
      if (key) parts.push(`${key}=${val}`);
    }
    return parts.length > 0 ? ' ' + parts.join(' ') : '';
  }

  private writeResourceDetailed(lines: string[], resource: IResourceProfiles): void {
    if (resource.schemaUrl) {
      lines.push(`    Resource SchemaURL: ${resource.schemaUrl}`);
    }
    const attrs = resource.resource?.attributes ?? [];
    if (attrs.length > 0) {
      lines.push('    Resource attributes:');
      for (const a of attrs) {
        const val = this.formatAnyValue(a.value);
        const type = this.attrType(a.value);
        lines.push(`         -> ${a.key}: ${val} (${type})`);
      }
    }
  }

  private writeScopeDetailed(lines: string[], scope: IScopeProfiles): void {
    if (scope.schemaUrl) {
      lines.push(`    ScopeProfiles SchemaURL: ${scope.schemaUrl}`);
    }
    const s = scope.scope;
    if (s) {
      lines.push(`    InstrumentationScope ${s.name ?? ''}${s.version ? ' ' + s.version : ''}`);
    }
  }

  private writeProfileDetailed(
    lines: string[],
    profile: IProfile,
    index: number,
    dict: IProfilesDictionary | undefined,
    strings: string[],
  ): void {
    const profileId = this.formatProfileId(profile.profileId);
    lines.push(`    Profile #${index}`);
    lines.push(`        Profile ID: ${profileId}`);
    if (profile.sampleType) {
      const t = strings[profile.sampleType.typeStrindex ?? 0] ?? '';
      const u = strings[profile.sampleType.unitStrindex ?? 0] ?? '';
      lines.push(`        Sample type: ${t}/${u}`);
    }
    if (profile.periodType) {
      const t = strings[profile.periodType.typeStrindex ?? 0] ?? '';
      const u = strings[profile.periodType.unitStrindex ?? 0] ?? '';
      lines.push(`        Period type: ${t}/${u}`);
    }
    if (profile.period) {
      lines.push(`        Period: ${profile.period}`);
    }
    if (profile.timeUnixNano) {
      lines.push(`        Start time: ${profile.timeUnixNano}`);
    }
    if (profile.durationNano) {
      lines.push(`        Duration: ${profile.durationNano}ns`);
    }
    if (profile.droppedAttributesCount) {
      lines.push(`        Dropped attributes count: ${profile.droppedAttributesCount}`);
    }
    if (profile.originalPayloadFormat) {
      lines.push(`        Original payload format: ${profile.originalPayloadFormat}`);
    }

    const samples = profile.samples ?? [];
    for (let si = 0; si < samples.length; si++) {
      const sample = samples[si];
      const values = (sample.values ?? []).join(', ');
      lines.push(`        Sample #${si}`);
      lines.push(`            Values: ${values}`);

      const attrIndices = sample.attributeIndices ?? [];
      if (attrIndices.length > 0 && dict) {
        const attrs = dict.attributeTable ?? [];
        lines.push('            Attributes:');
        for (const idx of attrIndices) {
          const attr = attrs[idx];
          if (!attr) continue;
          const key = strings[attr.keyStrindex ?? 0] ?? '';
          const val = this.formatAnyValue(attr.value);
          lines.push(`                 -> ${key}: ${val}`);
        }
      }

      if (sample.linkIndex && sample.linkIndex > 0 && dict) {
        const link = (dict.linkTable ?? [])[sample.linkIndex];
        if (link) {
          const traceId = link.traceId ? Buffer.from(link.traceId).toString('hex') : '';
          const spanId = link.spanId ? Buffer.from(link.spanId).toString('hex') : '';
          lines.push('            Link:');
          lines.push(`                 -> Trace ID: ${traceId}`);
          lines.push(`                 -> Span ID: ${spanId}`);
        }
      }
    }
  }

  private writeDictionaryDetailed(
    lines: string[],
    dict: IProfilesDictionary | undefined,
    strings: string[],
  ): void {
    if (!dict) return;

    lines.push('Dictionary:');

    const mappings = dict.mappingTable ?? [];
    if (mappings.length > 1) {
      lines.push('    Mappings:');
      for (let i = 1; i < mappings.length; i++) {
        const m = mappings[i];
        lines.push(`        Mapping #${i}`);
        lines.push(`            Memory start: ${m.memoryStart ?? 0}`);
        lines.push(`            Memory limit: ${m.memoryLimit ?? 0}`);
        lines.push(`            File offset: ${m.fileOffset ?? 0}`);
        lines.push(`            Filename: ${strings[m.filenameStrindex ?? 0] ?? ''}`);
      }
    }

    const locations = dict.locationTable ?? [];
    if (locations.length > 1) {
      lines.push('    Locations:');
      for (let i = 1; i < locations.length; i++) {
        const loc = locations[i];
        lines.push(`        Location #${i}`);
        lines.push(`            Mapping index: ${loc.mappingIndex ?? 0}`);
        lines.push(`            Address: ${loc.address ?? 0}`);
      }
    }

    const functions = dict.functionTable ?? [];
    if (functions.length > 1) {
      lines.push('    Functions:');
      for (let i = 1; i < functions.length; i++) {
        const fn = functions[i];
        lines.push(`        Function #${i}`);
        lines.push(`            Name: ${strings[fn.nameStrindex ?? 0] ?? ''}`);
        lines.push(`            System name: ${strings[fn.systemNameStrindex ?? 0] ?? ''}`);
        lines.push(`            Filename: ${strings[fn.filenameStrindex ?? 0] ?? ''}`);
        lines.push(`            Start line: ${fn.startLine ?? 0}`);
      }
    }

    const linkTable = dict.linkTable ?? [];
    if (linkTable.length > 1) {
      lines.push('    Links:');
      for (let i = 1; i < linkTable.length; i++) {
        const link = linkTable[i];
        const traceId = link.traceId ? Buffer.from(link.traceId).toString('hex') : '';
        const spanId = link.spanId ? Buffer.from(link.spanId).toString('hex') : '';
        lines.push(`        Link #${i}`);
        lines.push(`            Trace ID: ${traceId}`);
        lines.push(`            Span ID: ${spanId}`);
      }
    }

    if (strings.length > 1) {
      lines.push(`    String table: ${strings.length} entries`);
    }
  }

  private attrType(v: IAnyValue | null | undefined): string {
    if (!v) return 'Unknown';
    if (v.stringValue != null) return 'Str';
    if (v.intValue != null) return 'Int';
    if (v.boolValue != null) return 'Bool';
    if (v.doubleValue != null) return 'Double';
    return 'Unknown';
  }
}
