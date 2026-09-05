import { expect, test } from "bun:test"
import {
  type TinyHyperGraphRegionCostAdjustment,
  TinyHyperGraphSectionPipelineSolver,
  type TinyHyperGraphSectionSolver,
  type TinyHyperGraphSolver,
  type TinyHyperGraphSolverOptionTarget,
} from "lib/index"
import { sectionSolverFixtureGraph } from "tests/fixtures/section-solver.fixture"

test("section pipeline propagates one regional cost adjustment to every solver", () => {
  const regionCostAdjustment: TinyHyperGraphRegionCostAdjustment = () => 0
  const pipelineSolver = new TinyHyperGraphSectionPipelineSolver({
    serializedHyperGraph: sectionSolverFixtureGraph,
    regionCostAdjustment,
  })

  pipelineSolver.solve()

  const solveGraphSolver =
    pipelineSolver.getSolver<TinyHyperGraphSolver>("solveGraph")
  const sectionSolver =
    pipelineSolver.getSolver<TinyHyperGraphSectionSolver>("optimizeSection")
  const sectionSolverOptionTarget = sectionSolver as
    | TinyHyperGraphSolverOptionTarget
    | undefined

  expect(solveGraphSolver?.regionCostAdjustment).toBe(regionCostAdjustment)
  expect(sectionSolverOptionTarget?.regionCostAdjustment).toBe(
    regionCostAdjustment,
  )
  expect(sectionSolver?.baselineSolver.regionCostAdjustment).toBe(
    regionCostAdjustment,
  )
  expect(sectionSolver?.optimizedSolver?.regionCostAdjustment).toBe(
    regionCostAdjustment,
  )
})
