/**
 * Basic profiling example with ConsoleExporter.
 *
 * Run:
 *   npx ts-node examples/basic.ts
 */
import { ProfilingProvider, ConsoleProfileExporter } from '../src';

async function main(): Promise<void> {
  const provider = new ProfilingProvider({
    serviceName: 'basic-example',
    exporters: [new ConsoleProfileExporter({ verbosity: 'detailed' })],
    collectionIntervalMs: 5_000,
  });

  await provider.start();
  console.log('Profiling started — generating CPU work for ~15s...');

  // Simulate CPU-intensive work
  function fibonacci(n: number): number {
    if (n <= 1) return n;
    return fibonacci(n - 1) + fibonacci(n - 2);
  }

  // Simulate memory allocations
  function allocate(): string[] {
    const data: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      data.push(`item-${i}-${'x'.repeat(100)}`);
    }
    return data;
  }

  const interval = setInterval(() => {
    fibonacci(35);
    allocate();
  }, 1_000);

  setTimeout(async () => {
    clearInterval(interval);
    await provider.stop();
    console.log('Done.');
  }, 15_000);
}

main();
