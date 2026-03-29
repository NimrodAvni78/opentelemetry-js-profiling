import { ProfileData, ProfileExporter } from '../types';

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
    const dict = data.request.dictionary;
    const strings = (dict?.stringTable as string[]) ?? [];
    const sampleCount = this.countSamples(data);

    // Basic: summary line only (matches debug exporter zap.Info)
    console.log(`Profiles\tresource profiles: ${rp.length}, sample records: ${sampleCount}`);

    if (this.verbosity === 'basic') return;

    // Normal + Detailed
    const lines: string[] = [];
    for (let ri = 0; ri < rp.length; ri++) {
      const resource = rp[ri];
      const resourceAttrs = this.formatAttributes(resource.resource?.attributes ?? []);
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

  private countSamples(data: ProfileData): number {
    let count = 0;
    for (const rp of data.request.resourceProfiles ?? []) {
      for (const sp of rp.scopeProfiles ?? []) {
        for (const p of sp.profiles ?? []) {
          count += (p.samples ?? []).length;
        }
      }
    }
    return count;
  }

  private formatAttributes(
    attrs: {
      key?: string | null;
      value?: {
        stringValue?: string | null;
        intValue?: number | Long | null;
        boolValue?: boolean | null;
        doubleValue?: number | null;
      } | null;
    }[],
  ): string {
    if (attrs.length === 0) return '';
    const parts = attrs.map((a) => {
      const v = a.value;
      const val = v?.stringValue ?? v?.intValue ?? v?.boolValue ?? v?.doubleValue ?? '';
      return `${a.key}=${val}`;
    });
    return ' ' + parts.join(' ');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private formatScope(scope: any): string {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    indices: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dict: any,
    strings: string[],
  ): string {
    if (!indices || indices.length === 0 || !dict) return '';
    const attrs = dict.attributeTable ?? [];
    const parts: string[] = [];
    for (const idx of indices) {
      const attr = attrs[typeof idx === 'number' ? idx : 0];
      if (!attr) continue;
      const key = strings[attr.keyStrindex ?? 0] ?? '';
      const v = attr.value;
      const val = v?.stringValue ?? v?.intValue ?? v?.boolValue ?? v?.doubleValue ?? '';
      if (key) parts.push(`${key}=${val}`);
    }
    return parts.length > 0 ? ' ' + parts.join(' ') : '';
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private writeResourceDetailed(lines: string[], resource: any): void {
    if (resource.schemaUrl) {
      lines.push(`    Resource SchemaURL: ${resource.schemaUrl}`);
    }
    const attrs = resource.resource?.attributes ?? [];
    if (attrs.length > 0) {
      lines.push('    Resource attributes:');
      for (const a of attrs) {
        const v = a.value;
        const val = v?.stringValue ?? v?.intValue ?? v?.boolValue ?? v?.doubleValue ?? '';
        const type = this.attrType(v);
        lines.push(`         -> ${a.key}: ${val} (${type})`);
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private writeScopeDetailed(lines: string[], scope: any): void {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    profile: any,
    index: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dict: any,
    strings: string[],
  ): void {
    const profileId = this.formatProfileId(profile.profileId);
    lines.push(`    Profile #${index}`);
    lines.push(`        Profile ID: ${profileId}`);
    if (profile.timeUnixNano) {
      lines.push(`        Start time: ${profile.timeUnixNano}`);
    }
    if (profile.durationNano) {
      lines.push(`        DurationNano: ${profile.durationNano}`);
    }
    if (profile.droppedAttributesCount) {
      lines.push(`        Dropped attributes count: ${profile.droppedAttributesCount}`);
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
          const attr = attrs[typeof idx === 'number' ? idx : 0];
          if (!attr) continue;
          const key = strings[attr.keyStrindex ?? 0] ?? '';
          const v = attr.value;
          const val = v?.stringValue ?? v?.intValue ?? v?.boolValue ?? v?.doubleValue ?? '';
          lines.push(`                 -> ${key}: ${val}`);
        }
      }

      if (sample.linkIndex && sample.linkIndex > 0 && dict) {
        const link = (dict.linkTable ?? [])[sample.linkIndex];
        if (link) {
          const traceId = link.traceId ? Buffer.from(link.traceId).toString('hex') : '';
          const spanId = link.spanId ? Buffer.from(link.spanId).toString('hex') : '';
          lines.push(`            Link:`);
          lines.push(`                 -> Trace ID: ${traceId}`);
          lines.push(`                 -> Span ID: ${spanId}`);
        }
      }
    }
  }

  private writeDictionaryDetailed(
    lines: string[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dict: any,
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private attrType(v: any): string {
    if (v?.stringValue != null) return 'Str';
    if (v?.intValue != null) return 'Int';
    if (v?.boolValue != null) return 'Bool';
    if (v?.doubleValue != null) return 'Double';
    return 'Unknown';
  }
}

type Long = number | { low: number; high: number };
