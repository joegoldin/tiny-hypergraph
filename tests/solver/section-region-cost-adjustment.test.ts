import { expect, test } from "bun:test"
import * as datasetHg07 from "dataset-hg07"
import {
  loadSerializedHyperGraph,
  type TinyHyperGraphRegionCostAdjustment,
  TinyHyperGraphSectionPipelineSolver,
  TinyHyperGraphSectionSolver,
  TinyHyperGraphSolver,
  type TinyHyperGraphSolverOptionTarget,
} from "lib/index"
import {
  createSectionSolverFixturePortMask,
  sectionSolverFixtureGraph,
} from "tests/fixtures/section-solver.fixture"

test("section pipeline propagates one regional cost adjustment to every solver", () => {
  let misleadingErrorAdjustmentCalls = 0
  const misleadingErrorPipeline = new TinyHyperGraphSectionPipelineSolver({
    serializedHyperGraph: sectionSolverFixtureGraph,
    solveGraphOptions: {
      regionCostAdjustment: () => 0.01,
    },
    sectionSolverOptions: {
      regionCostAdjustment: () => {
        misleadingErrorAdjustmentCalls += 1
        if (misleadingErrorAdjustmentCalls === 21) {
          throw new Error(
            "callback enters the section multiple times unexpectedly",
          )
        }
        return 0
      },
    },
  })

  expect(() => misleadingErrorPipeline.solve()).toThrow(
    "callback enters the section multiple times unexpectedly",
  )

  let automaticSectionAdjustmentCalls = 0
  const invalidAutomaticSectionPipeline =
    new TinyHyperGraphSectionPipelineSolver({
      serializedHyperGraph: sectionSolverFixtureGraph,
      solveGraphOptions: {
        regionCostAdjustment: () => 0.01,
      },
      sectionSolverOptions: {
        regionCostAdjustment: () => {
          automaticSectionAdjustmentCalls += 1
          return automaticSectionAdjustmentCalls === 21 ? -1 : 0
        },
      },
    })

  expect(() => invalidAutomaticSectionPipeline.solve()).toThrow(
    "Invalid regional cost adjustment",
  )

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

  let topLevelAdjustmentCalls = 0
  let solveGraphAdjustmentCalls = 0
  let sectionAdjustmentCalls = 0
  const topLevelAdjustment: TinyHyperGraphRegionCostAdjustment = () => {
    topLevelAdjustmentCalls += 1
    return 0
  }
  const solveGraphAdjustment: TinyHyperGraphRegionCostAdjustment = () => {
    solveGraphAdjustmentCalls += 1
    return 0.01
  }
  const sectionAdjustment: TinyHyperGraphRegionCostAdjustment = () => {
    sectionAdjustmentCalls += 1
    return 0
  }
  const overridePipeline = new TinyHyperGraphSectionPipelineSolver({
    serializedHyperGraph: sectionSolverFixtureGraph,
    regionCostAdjustment: topLevelAdjustment,
    solveGraphOptions: {
      regionCostAdjustment: solveGraphAdjustment,
    },
    sectionSolverOptions: {
      regionCostAdjustment: sectionAdjustment,
    },
  })

  overridePipeline.solve()

  expect(topLevelAdjustmentCalls).toBe(0)
  expect(solveGraphAdjustmentCalls).toBeGreaterThan(0)
  expect(sectionAdjustmentCalls).toBeGreaterThan(0)
  expect(overridePipeline.stats.sectionSearchCandidateCount).toBeGreaterThan(0)
  expect(
    overridePipeline.getSolver<TinyHyperGraphSolver>("solveGraph")
      ?.regionCostAdjustment,
  ).toBe(solveGraphAdjustment)
  expect(
    (
      overridePipeline.getSolver<TinyHyperGraphSectionSolver>(
        "optimizeSection",
      ) as TinyHyperGraphSolverOptionTarget | undefined
    )?.regionCostAdjustment,
  ).toBe(sectionAdjustment)

  let automaticReplayObserved = false
  const automaticReplayPipeline = new TinyHyperGraphSectionPipelineSolver({
    serializedHyperGraph: datasetHg07.sample029,
    regionCostAdjustment: () => {
      if (
        !automaticReplayObserved &&
        new Error().stack?.includes("getSerializedOutputMaxRegionCost")
      ) {
        automaticReplayObserved = true
      }
      return 0
    },
  })

  automaticReplayPipeline.solve()

  expect(automaticReplayPipeline.selectedSectionCandidateLabel).toBeDefined()
  expect(automaticReplayObserved).toBe(true)

  const { topology, problem, solution } = loadSerializedHyperGraph(
    sectionSolverFixtureGraph,
  )
  problem.portSectionMask = createSectionSolverFixturePortMask(topology)
  let replayAdjustmentCalls = 0
  const replaySectionSolver = new TinyHyperGraphSectionSolver(
    topology,
    problem,
    solution,
    {
      regionCostAdjustment: () => {
        replayAdjustmentCalls += 1
        return 0
      },
    },
  )
  const callsAfterBaselineReplay = replayAdjustmentCalls
  expect(callsAfterBaselineReplay).toBeGreaterThan(0)

  replaySectionSolver.setup()
  const callsAfterSectionSearchSetup = replayAdjustmentCalls
  expect(callsAfterSectionSearchSetup).toBeGreaterThan(callsAfterBaselineReplay)

  replaySectionSolver.sectionSolver?.solve()
  const callsAfterSectionSearch = replayAdjustmentCalls
  expect(callsAfterSectionSearch).toBeGreaterThan(callsAfterSectionSearchSetup)

  replaySectionSolver._step()
  expect(replayAdjustmentCalls).toBeGreaterThan(callsAfterSectionSearch)
  expect(replaySectionSolver.optimizedSolver).toBeDefined()

  const greedyInput = loadSerializedHyperGraph(sectionSolverFixtureGraph)
  let greedyFinalAdjustmentCalls = 0
  const greedyFinalSolver = new TinyHyperGraphSolver(
    greedyInput.topology,
    greedyInput.problem,
    {
      GREEDY_FINAL_ROUTE_ITERS: 1,
      regionCostAdjustment: () => {
        greedyFinalAdjustmentCalls += 1
        return 0
      },
    },
  )

  greedyFinalSolver.tryFinalAcceptance()

  expect(greedyFinalSolver.stats.acceptedGreedyFinalRouteOnTimeout).toBe(true)
  expect(greedyFinalAdjustmentCalls).toBeGreaterThan(0)
})
