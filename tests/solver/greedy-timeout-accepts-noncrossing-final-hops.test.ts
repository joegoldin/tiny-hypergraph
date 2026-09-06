import { expect, test } from "bun:test"
import { loadSerializedHyperGraph } from "lib/compat/loadSerializedHyperGraph"
import { DistanceAwareTinyHyperGraphSolver } from "lib/distance-aware-tiny-hypergraph-solver"
import { createFourPortSingleLayerGreedyGraph } from "tests/fixtures/four-port-single-layer-greedy"

test("greedy timeout completion accepts complete noncrossing final hops", (): void => {
  const { topology, problem } = loadSerializedHyperGraph(
    createFourPortSingleLayerGreedyGraph(false),
  )
  let regionalAdjustmentCalls = 0
  const solver = new DistanceAwareTinyHyperGraphSolver(topology, problem, {
    ACCEPT_BEST_SOLUTION_ON_TIMEOUT: true,
    GREEDY_FINAL_ROUTE_ITERS: 1,
    RIP_THRESHOLD_RAMP_ATTEMPTS: 0,
    regionCostAdjustment: () => {
      regionalAdjustmentCalls += 1
      return 0
    },
  })

  solver.tryFinalAcceptance()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.stats.acceptedGreedyFinalRouteOnTimeout).toBe(true)
  expect(solver.state.unroutedRoutes).toEqual([])
  expect(Array.from(solver.state.portAssignment)).toEqual([0, 0, 1, 1])
  expect(
    solver.state.regionSegments.flat().map(([routeId]) => routeId).sort(),
  ).toEqual([0, 1])
  expect(
    solver.state.regionIntersectionCaches.every(
      (cache) => cache.existingSameLayerIntersections === 0,
    ),
  ).toBe(true)
  expect(regionalAdjustmentCalls).toBeGreaterThan(0)
})
