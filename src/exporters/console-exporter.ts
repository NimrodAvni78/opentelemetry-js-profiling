import { ProfileData, ProfileExporter } from '../types';

export class ConsoleProfileExporter implements ProfileExporter {
  async export(data: ProfileData): Promise<void> {
    const duration = data.stoppedAt.getTime() - data.startedAt.getTime();
    const rp = data.request.resourceProfiles?.[0];
    const dict = data.request.dictionary;
    const profile = rp?.scopeProfiles?.[0]?.profiles?.[0];
    const strings = dict?.stringTable ?? [];
    const functions = dict?.functionTable ?? [];
    const locations = dict?.locationTable ?? [];
    const stacks = dict?.stackTable ?? [];
    const samples = profile?.samples ?? [];

    // Service name from resource attributes
    const serviceNameAttr = rp?.resource?.attributes?.find((a) => a.key === 'service.name');
    const serviceName = serviceNameAttr?.value?.stringValue ?? 'unknown';

    // Sample type
    const sampleType = profile?.sampleType;
    const sampleTypeStr = sampleType
      ? `${strings[sampleType.typeStrindex ?? 0] ?? '?'}(${strings[sampleType.unitStrindex ?? 0] ?? '?'})`
      : '?';

    // Aggregate values
    let totalValue = 0;
    for (const sample of samples) {
      for (const v of sample.values ?? []) {
        totalValue += typeof v === 'number' ? v : Number(v);
      }
    }

    // Top functions by leaf frame frequency
    const leafCounts = new Map<string, number>();
    for (const sample of samples) {
      const stackIdx = sample.stackIndex ?? 0;
      const stack = stacks[stackIdx];
      const locIndices = stack?.locationIndices ?? [];
      if (locIndices.length === 0) continue;

      const leafLocIdx = locIndices[0];
      const loc = locations[typeof leafLocIdx === 'number' ? leafLocIdx : 0];
      const lines = loc?.lines ?? [];
      if (lines.length === 0) continue;

      const funcIdx = lines[0].functionIndex ?? 0;
      const fn = functions[typeof funcIdx === 'number' ? funcIdx : 0];
      const nameIdx = fn?.nameStrindex ?? 0;
      const name = strings[typeof nameIdx === 'number' ? nameIdx : 0] || '(unknown)';
      leafCounts.set(name, (leafCounts.get(name) ?? 0) + 1);
    }
    const topFunctions = [...leafCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

    console.log(
      `--- Profile [${data.profileType}] ---\n` +
        `  Service:    ${serviceName}\n` +
        `  Duration:   ${duration}ms\n` +
        `  Samples:    ${samples.length}\n` +
        `  Functions:  ${functions.length}\n` +
        `  Type:       ${sampleTypeStr}\n` +
        `  Total:      ${sampleTypeStr}=${totalValue}\n` +
        `  Top frames:\n` +
        topFunctions
          .map(([name, count]) => `    ${count.toString().padStart(5)} ${name}`)
          .join('\n'),
    );
  }

  async shutdown(): Promise<void> {}
}
