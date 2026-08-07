import { expect, test } from "bun:test"
import {
  type TinyHyperGraphProblem,
  TinyHyperGraphSolver,
  type TinyHyperGraphTopology,
} from "lib/index"

test("reproduces greedy final routing through a same-layer crossing", () => {
  const topology: TinyHyperGraphTopology = {
    portCount: 4,
    regionCount: 5,
    regionIncidentPorts: [[0, 1, 2, 3], [0], [1], [2], [3]],
    incidentPortRegion: [
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
    ],
    regionWidth: new Float64Array(5).fill(1),
    regionHeight: new Float64Array(5).fill(1),
    regionCenterX: new Float64Array(5),
    regionCenterY: new Float64Array(5),
    regionAvailableZMask: Int32Array.from([1, 1, 1, 1, 1]),
    portAngleForRegion1: Int32Array.from([0, 1, 2, 3]),
    portAngleForRegion2: new Int32Array(4),
    portX: new Float64Array(4),
    portY: new Float64Array(4),
    portZ: new Int32Array(4),
  }
  const problem: TinyHyperGraphProblem = {
    routeCount: 2,
    portSectionMask: new Int8Array(4).fill(1),
    routeStartPort: Int32Array.from([0, 1]),
    routeEndPort: Int32Array.from([2, 3]),
    routeNet: Int32Array.from([0, 1]),
    regionNetId: new Int32Array(5).fill(-1),
    initialAssignments: [
      { routeId: 0, regionId: 0, fromPortId: 0, toPortId: 2 },
    ],
  }
  const solver = new TinyHyperGraphSolver(topology, problem, {
    GREEDY_FINAL_ROUTE_ITERS: 1,
  })

  solver.tryFinalAcceptance()

  expect({
    solved: solver.solved,
    acceptedGreedyFinalRouteOnTimeout:
      solver.stats.acceptedGreedyFinalRouteOnTimeout,
    sameLayerCrossings:
      solver.state.regionIntersectionCaches[0].existingSameLayerIntersections,
  }).toMatchInlineSnapshot(`
    {
      "acceptedGreedyFinalRouteOnTimeout": true,
      "sameLayerCrossings": 1,
      "solved": true,
    }
  `)
})
