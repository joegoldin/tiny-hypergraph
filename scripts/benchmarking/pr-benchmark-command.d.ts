export type PrBenchmarkCommand = {
  benchmarkArgs: string[]
}

export function parsePrBenchmarkCommand(body: string): PrBenchmarkCommand
