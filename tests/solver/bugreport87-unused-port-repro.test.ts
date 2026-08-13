import "bun-match-svg"
import { expect, test } from "bun:test"
import type { SerializedHyperGraph } from "@tscircuit/hypergraph"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { loadSerializedHyperGraph } from "lib/compat/loadSerializedHyperGraph"
import {
  SelectiveReripTinyHyperGraphSolver,
  type TinyHyperGraphSolverOptions,
} from "lib/index"
import fixture from "tests/fixtures/bugreport87-unused-port-repro.json" with {
  type: "json",
}

const repro = fixture as unknown as {
  serializedHyperGraph: SerializedHyperGraph
  solveGraphOptions: TinyHyperGraphSolverOptions
}

test("repro: unused port triggers a repeated selective rerip cycle", () => {
  const { topology, problem } = loadSerializedHyperGraph(
    repro.serializedHyperGraph,
  )
  const solver = new SelectiveReripTinyHyperGraphSolver(
    topology,
    problem,
    repro.solveGraphOptions,
  )

  solver.solve()

  expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 120_000)
