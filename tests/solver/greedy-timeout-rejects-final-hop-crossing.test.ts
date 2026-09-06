import { expect, test } from "bun:test"
import { loadSerializedHyperGraph } from "lib/compat/loadSerializedHyperGraph"
import { DistanceAwareTinyHyperGraphSolver } from "lib/distance-aware-tiny-hypergraph-solver"
import { createFourPortSingleLayerGreedyGraph } from "tests/fixtures/four-port-single-layer-greedy"

test("greedy timeout completion rejects an impossible final-hop crossing", (): void => {
  const { topology, problem } = loadSerializedHyperGraph(
    createFourPortSingleLayerGreedyGraph(true),
  )
  const solver = new DistanceAwareTinyHyperGraphSolver(topology, problem, {
    ACCEPT_BEST_SOLUTION_ON_TIMEOUT: true,
    GREEDY_FINAL_ROUTE_ITERS: 1,
    RIP_THRESHOLD_RAMP_ATTEMPTS: 0,
  })

  solver.tryFinalAcceptance()

  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(false)
  expect(solver.stats.acceptedGreedyFinalRouteOnTimeout).toBeUndefined()
  expect(solver.stats.greedyFinalRouteAttemptCount).toBe(1)
  expect(solver.stats.greedyFinalRouteRemainingRouteCount).toBe(2)
  expect(Array.from(solver.state.portAssignment)).toEqual([-1, -1, -1, -1])
  expect(solver.state.unroutedRoutes).toEqual([0, 1])
  expect(
    solver.state.regionSegments.every((segments) => segments.length === 0),
  ).toBe(true)
  expect(
    solver.state.regionIntersectionCaches.every(
      (cache) => cache.existingSameLayerIntersections === 0,
    ),
  ).toBe(true)
})
