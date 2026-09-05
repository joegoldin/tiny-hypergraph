import { expect, test } from "bun:test"
import { computeRegionCost } from "lib/computeRegionCost"
import {
  type TinyHyperGraphProblem,
  TinyHyperGraphSolver,
  type TinyHyperGraphTopology,
} from "lib/index"

const createTopology = (): TinyHyperGraphTopology => ({
  portCount: 4,
  regionCount: 2,
  regionIncidentPorts: [[0, 1, 2, 3], []],
  incidentPortRegion: [
    [0, 1],
    [0, 1],
    [0, 1],
    [0, 1],
  ],
  regionWidth: new Float64Array([4, 1]),
  regionHeight: new Float64Array([4, 1]),
  regionCenterX: new Float64Array(2),
  regionCenterY: new Float64Array(2),
  regionMetadata: [{ capacityMeshNodeId: "dense" }, {}],
  portAngleForRegion1: new Int32Array([0, 9000, 18000, 27000]),
  portAngleForRegion2: new Int32Array(4),
  portX: new Float64Array([1, 0, -1, 0]),
  portY: new Float64Array([0, 1, 0, -1]),
  portZ: new Int32Array([0, 0, 1, 0]),
})

const createProblem = (): TinyHyperGraphProblem => ({
  routeCount: 2,
  portSectionMask: new Int8Array(4).fill(1),
  routeStartPort: new Int32Array([0, 1]),
  routeEndPort: new Int32Array([2, 3]),
  routeNet: new Int32Array([0, 1]),
  regionNetId: new Int32Array(2).fill(-1),
})

test("regional adjustment contributes to cached and candidate region costs", () => {
  const solver = new TinyHyperGraphSolver(createTopology(), createProblem(), {
    regionCostAdjustment: ({
      regionMetadata,
      sameLayerCrossings,
      crossLayerCrossings,
      entryExitLayerChanges,
    }) => {
      if (regionMetadata?.capacityMeshNodeId !== "dense") return 0
      return (
        0.5 *
        (2 * sameLayerCrossings + crossLayerCrossings + entryExitLayerChanges)
      )
    },
  })

  solver.state.currentRouteNetId = 0
  solver.appendSegmentToRegionCache(0, 0, 2)

  const cachedCost = solver.state.regionIntersectionCaches[0].existingRegionCost
  const unadjustedCachedCost = computeRegionCost(4, 4, 0, 0, 1, 1)
  expect(cachedCost).toBeCloseTo(unadjustedCachedCost + 0.5)

  solver.state.currentRouteNetId = 1
  const candidateCost = solver.computeG(
    {
      nextRegionId: 0,
      portId: 1,
      f: 0,
      g: 0,
      h: 0,
    },
    3,
  )
  const unadjustedCandidateTotal = computeRegionCost(4, 4, 1, 0, 1, 2)

  expect(candidateCost).toBeCloseTo(unadjustedCandidateTotal + 1.5 - cachedCost)
})

test("regional adjustment rejects non-finite and negative results", () => {
  for (const adjustment of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const solver = new TinyHyperGraphSolver(createTopology(), createProblem(), {
      regionCostAdjustment: () => adjustment,
    })
    solver.state.currentRouteNetId = 0

    expect(() => solver.appendSegmentToRegionCache(0, 0, 2)).toThrow(
      `Invalid regional cost adjustment for region 0: ${adjustment}`,
    )
  }
})
