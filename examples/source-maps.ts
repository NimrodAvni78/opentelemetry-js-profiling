/**
 * Source map support example.
 *
 * Profiles normally show compiled JS filenames and line numbers.
 * With sourceMapSearchPaths, the profiler maps them back to original
 * TypeScript (or other) source files.
 *
 * Setup:
 *   1. Build your project with source maps enabled (tsconfig: "sourceMap": true)
 *   2. Point sourceMapSearchPaths at the directory containing your compiled JS + .map files
 *
 * Run:
 *   npx tsc --sourceMap -outDir dist examples/source-maps.ts
 *   node dist/examples/source-maps.js
 *
 * Without source maps, profiles show:
 *   dist/examples/source-maps.js:30  computeHash
 *
 * With source maps, profiles show:
 *   examples/source-maps.ts:42  computeHash
 */
import { ProfilingProvider, ConsoleProfileExporter } from '../src';

async function main(): Promise<void> {
  const provider = new ProfilingProvider({
    serviceName: 'source-map-example',
    exporter: new ConsoleProfileExporter({ verbosity: 'detailed' }),
    collectionIntervalMs: 5_000,
    heapProfilingEnabled: false,
    // Point at the directory containing compiled .js and .js.map files
    sourceMapSearchPaths: ['./dist'],
  });

  await provider.start();
  console.log('Profiling with source maps enabled — generating work for ~10s...');

  // Simulate application work
  function computeHash(input: string): number {
    let hash = 0;
    for (let i = 0; i < 100_000; i++) {
      for (let j = 0; j < input.length; j++) {
        hash = (hash * 31 + input.charCodeAt(j)) | 0;
      }
    }
    return hash;
  }

  function processRequest(id: number): void {
    const result = computeHash(`request-${id}-${'x'.repeat(50)}`);
    if (result === 0) console.log('unlikely');
  }

  const interval = setInterval(() => {
    processRequest(Math.random());
  }, 200);

  setTimeout(async () => {
    clearInterval(interval);
    await provider.stop();
    console.log('Done.');
  }, 10_000);
}

main();
