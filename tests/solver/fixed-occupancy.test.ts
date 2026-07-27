import { expect, test } from "bun:test"
import {
  SelectiveReripTinyHyperGraphSolver,
  TinyHyperGraphSectionSolver,
  TinyHyperGraphSolver,
  type TinyHyperGraphProblem,
  type TinyHyperGraphSolution,
  type TinyHyperGraphTopology,
} from "lib/index"

const createTopology = (): TinyHyperGraphTopology => ({
  portCount: 8,
  regionCount: 1,
  regionIncidentPorts: [[0, 1, 2, 3, 4, 5, 6, 7]],
  incidentPortRegion: Array.from({ length: 8 }, () => [0]),
  regionWidth: new Float64Array([2]),
  regionHeight: new Float64Array([2]),
  regionCenterX: new Float64Array([0]),
  regionCenterY: new Float64Array([0]),
  regionAvailableZMask: new Int32Array([0b11]),
  portAngleForRegion1: new Int32Array([
    0, 9000, 18000, 27000, 0, 9000, 18000, 27000,
  ]),
  portX: new Float64Array([1, 0, -1, 0, 1, 0, -1, 0]),
  portY: new Float64Array([0, 1, 0, -1, 0, 1, 0, -1]),
  portZ: new Int32Array([0, 0, 0, 0, 1, 1, 1, 1]),
})

const createProblem = (): TinyHyperGraphProblem => ({
  routeCount: 1,
  portSectionMask: new Int8Array(8).fill(1),
  routeStartPort: new Int32Array([4]),
  routeEndPort: new Int32Array([6]),
  routeNet: new Int32Array([20]),
  regionNetId: new Int32Array([-1]),
  fixedOccupancy: {
    portReservations: [{ portId: 7, netId: 30 }],
    segments: [
      {
        regionId: 0,
        fromPortId: 0,
        toPortId: 2,
        netId: 10,
        geometry: {
          start: { x: -0.75, y: 0 },
          end: { x: 0.75, y: 0 },
        },
      },
    ],
  },
})

test("fixed occupancy seeds caches and reservations without becoming route output", () => {
  const solver = new TinyHyperGraphSolver(createTopology(), createProblem(), {
    STATIC_REACHABILITY_PRECHECK: false,
  })

  expect([...solver.state.regionIntersectionCaches[0]!.netIds]).toEqual([10])
  expect(solver.state.regionSegments[0]).toEqual([])
  expect([...solver.problemSetup.portEndpointReservationNetId]).toEqual([
    10, -1, 10, -1, 20, -1, 20, 30,
  ])

  expect(solver.isHopBlockedByFixedOccupancy(0, 1, 3, 20)).toBe(true)
  expect(solver.isHopBlockedByFixedOccupancy(0, 1, 3, 10)).toBe(false)

  solver.resetRoutingStateForRerip()
  expect([...solver.state.regionIntersectionCaches[0]!.netIds]).toEqual([10])
  expect(solver.state.regionSegments[0]).toEqual([])
})

test("fixed occupancy blocks a foreign route whose goal hop crosses it", () => {
  const problem = createProblem()
  problem.routeStartPort[0] = 1
  problem.routeEndPort[0] = 3
  const solver = new TinyHyperGraphSolver(createTopology(), problem, {
    MAX_ITERATIONS: 20,
    STATIC_REACHABILITY_PRECHECK: false,
    ACCEPT_BEST_SOLUTION_ON_TIMEOUT: false,
  })

  solver.solve()

  expect(solver.state.regionSegments[0]).toEqual([])
  expect([...solver.state.regionIntersectionCaches[0]!.netIds]).toEqual([10])
})

test("optional physical geometry catches crossings hidden by port angles", () => {
  const topology = createTopology()
  topology.portX[2] = 0
  topology.portY[2] = -1
  topology.portX[3] = 0
  topology.portY[3] = 1
  const problem = createProblem()
  problem.fixedOccupancy!.segments = [
    {
      regionId: 0,
      fromPortId: 0,
      toPortId: 1,
      netId: 10,
      geometry: {
        start: { x: -0.75, y: 0 },
        end: { x: 0.75, y: 0 },
      },
    },
  ]
  const solver = new TinyHyperGraphSolver(topology, problem, {
    STATIC_REACHABILITY_PRECHECK: false,
  })

  expect(solver.isHopBlockedByFixedOccupancy(0, 2, 3, 20)).toBe(true)
})

class TestSelectiveReripSolver extends SelectiveReripTinyHyperGraphSolver {
  rebuildForTest(rippedRouteIds: ReadonlySet<number>) {
    this.rebuildCommittedState(rippedRouteIds)
  }
}

test("selective rerip rebuild preserves immutable occupancy exactly once", () => {
  const solver = new TestSelectiveReripSolver(
    createTopology(),
    createProblem(),
    {
      STATIC_REACHABILITY_PRECHECK: false,
    },
  )

  solver.state.regionSegments[0]!.push([0, 4, 6])
  solver.state.portAssignment[4] = 20
  solver.state.portAssignment[6] = 20
  solver.state.currentRouteNetId = 20
  solver.appendSegmentToRegionCache(0, 4, 6)

  solver.rebuildForTest(new Set())

  expect([...solver.state.regionIntersectionCaches[0]!.netIds]).toEqual([
    10, 20,
  ])
  expect(solver.state.regionSegments[0]).toEqual([[0, 4, 6]])
})

test("section replay retains fixed occupancy but excludes it from route state", () => {
  const solution: TinyHyperGraphSolution = {
    solvedRoutePathSegments: [[[4, 6]]],
    solvedRoutePathRegionIds: [[0]],
  }
  const problem = createProblem()
  problem.portSectionMask.fill(0)
  const solver = new TinyHyperGraphSectionSolver(
    createTopology(),
    problem,
    solution,
  )

  expect([
    ...solver.baselineSolver.state.regionIntersectionCaches[0]!.netIds,
  ]).toEqual([10, 20])

  solver.solve()

  expect(solver.solved).toBe(true)
  expect(
    solver.getSolvedSolver().state.regionIntersectionCaches[0]!.netIds.length,
  ).toBe(2)
  expect(solver.getSolvedSolver().state.regionSegments[0]).toEqual([[0, 4, 6]])
})

test("iteration zero renders fixed occupancy on its actual z layer", () => {
  const problem = createProblem()
  problem.fixedOccupancy!.segments!.push({
    regionId: 0,
    fromPortId: 4,
    toPortId: 6,
    netId: 11,
  })
  const solver = new TinyHyperGraphSolver(createTopology(), problem, {
    STATIC_REACHABILITY_PRECHECK: false,
  })

  const fixedLines = (solver.visualize().lines ?? []).filter((line) =>
    line.label?.includes("fixed occupancy"),
  )

  expect(fixedLines).toHaveLength(2)
  expect(fixedLines[0]?.strokeColor).toBe("rgba(220, 38, 38, 0.95)")
  expect(fixedLines[0]?.layer).toBe("z0")
  expect(fixedLines[1]?.strokeColor).toBe("rgba(52, 152, 219, 0.95)")
  expect(fixedLines[1]?.strokeDash).toBe("3 2")
  expect(fixedLines[1]?.layer).toBe("z1")
})
