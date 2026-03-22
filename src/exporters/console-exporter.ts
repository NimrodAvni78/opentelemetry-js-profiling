import { ProfileData, ProfileExporter, ResourceAttributes } from '../types';

type Numeric = number | bigint;

function toNumber(val: Numeric | null | undefined): number {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'bigint') return Number(val);
  return Number(val) || 0;
}

export class ConsoleProfileExporter implements ProfileExporter {
  async export(data: ProfileData, resource: ResourceAttributes): Promise<void> {
    const duration = data.stoppedAt.getTime() - data.startedAt.getTime();
    const sampleCount = data.profile.sample.length;
    const functionCount = data.profile.function.length;
    const strings = data.profile.stringTable.strings;

    // Aggregate values
    const sampleTypes = data.profile.sampleType.map(
      (st) => `${strings[toNumber(st.type)] || '?'}(${strings[toNumber(st.unit)] || '?'})`,
    );

    const totalValues = new Array(data.profile.sampleType.length).fill(0);
    for (const sample of data.profile.sample) {
      for (let i = 0; i < sample.value.length && i < totalValues.length; i++) {
        totalValues[i] += toNumber(sample.value[i]);
      }
    }

    // Top functions by frequency (leaf frame)
    const leafCounts = new Map<string, number>();
    for (const sample of data.profile.sample) {
      if (sample.locationId.length === 0) continue;
      const leafLocId = toNumber(sample.locationId[0]);
      const loc = data.profile.location.find((l) => toNumber(l.id) === leafLocId);
      if (loc && loc.line.length > 0) {
        const funcId = toNumber(loc.line[0].functionId);
        const func = data.profile.function.find((f) => toNumber(f.id) === funcId);
        if (func) {
          const name = strings[toNumber(func.name)] || '(unknown)';
          leafCounts.set(name, (leafCounts.get(name) || 0) + 1);
        }
      }
    }
    const topFunctions = [...leafCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

    console.log(
      `--- Profile [${data.profileType}] ---\n` +
        `  Service:    ${resource['service.name'] || 'unknown'}\n` +
        `  Duration:   ${duration}ms\n` +
        `  Samples:    ${sampleCount}\n` +
        `  Functions:  ${functionCount}\n` +
        `  Types:      ${sampleTypes.join(', ')}\n` +
        `  Totals:     ${totalValues.map((v, i) => `${sampleTypes[i]}=${v}`).join(', ')}\n` +
        `  Top frames:\n` +
        topFunctions
          .map(([name, count]) => `    ${count.toString().padStart(5)} ${name}`)
          .join('\n'),
    );
  }

  async shutdown(): Promise<void> {}
}
