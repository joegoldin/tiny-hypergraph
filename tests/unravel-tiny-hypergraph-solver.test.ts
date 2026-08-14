import { expect, test } from "bun:test"
import {
  type TinyHyperGraphProblem,
  TinyHyperGraphSolver,
  type TinyHyperGraphTopology,
  UnravelTinyHyperGraphSolver,
} from "lib/index"
import { loadSerializedHyperGraph } from "lib/compat/loadSerializedHyperGraph"
import { TinyHyperGraphSectionSolver } from "lib/section-solver"
import type { PortId, RegionId, RouteId } from "lib/types"

const createCrossedSolvedSolver = (portZ = new Int32Array(6)) => {
  const topology: TinyHyperGraphTopology = {
    portCount: 6,
    regionCount: 4,
    regionIncidentPorts: [
      [0, 1, 2, 3],
      [2, 3, 4, 5],
      [0, 1],
      [4, 5],
    ],
    incidentPortRegion: [
      [0, 2],
      [0, 2],
      [0, 1],
      [0, 1],
      [1, 3],
      [1, 3],
    ],
    regionWidth: new Float64Array(4).fill(1),
    regionHeight: new Float64Array(4).fill(1),
    regionCenterX: new Float64Array([0, 1, -1, 2]),
    regionCenterY: new Float64Array(4),
    portAngleForRegion1: new Int32Array([0, 9000, 18000, 27000, 18000, 27000]),
    portAngleForRegion2: new Int32Array([0, 9000, 0, 9000, 0, 9000]),
    portX: new Float64Array([-1, -1, 0.5, 0.5, 2, 2]),
    portY: new Float64Array([1, -1, 1, -1, 1, -1]),
    portZ,
  }
  const problem: TinyHyperGraphProblem = {
    routeCount: 2,
    portSectionMask: new Int8Array(6).fill(1),
    routeStartPort: new Int32Array([0, 1]),
    routeEndPort: new Int32Array([4, 5]),
    routeNet: new Int32Array([0, 1]),
    regionNetId: new Int32Array(4).fill(-1),
  }
  const solver = new TinyHyperGraphSolver(topology, problem)
  const addSegment = (
    regionId: RegionId,
    routeId: RouteId,
    fromPortId: PortId,
    toPortId: PortId,
  ) => {
    const routeNetId = problem.routeNet[routeId]!
    solver.state.currentRouteNetId = routeNetId
    solver.state.regionSegments[regionId]!.push([routeId, fromPortId, toPortId])
    solver.state.portAssignment[fromPortId] = routeNetId
    solver.state.portAssignment[toPortId] = routeNetId
    solver.appendSegmentToRegionCache(regionId, fromPortId, toPortId)
  }

  addSegment(0, 0, 0, 2)
  addSegment(1, 0, 2, 4)
  addSegment(0, 1, 1, 3)
  addSegment(1, 1, 3, 5)
  solver.state.currentRouteNetId = undefined
  solver.solved = true

  return solver
}

const getMaxRegionCost = (solver: TinyHyperGraphSolver) =>
  solver.state.regionIntersectionCaches.reduce(
    (maxCost, cache) => Math.max(maxCost, cache.existingRegionCost),
    0,
  )

const getTotalSegmentCount = (solver: TinyHyperGraphSolver) =>
  solver.state.regionSegments.reduce(
    (total, segments) => total + segments.length,
    0,
  )

const createSolvedSolverWithAlternatePath = () => {
  const topology: TinyHyperGraphTopology = {
    portCount: 13,
    regionCount: 13,
    regionIncidentPorts: [
      [0, 1, 3],
      [1, 2, 8, 9],
      [2, 5, 6],
      [3, 4, 11, 12],
      [4, 5],
      [7, 8],
      [9, 10],
      [0],
      [6],
      [7],
      [10],
      [11],
      [12],
    ],
    incidentPortRegion: [
      [0, 7],
      [0, 1],
      [1, 2],
      [0, 3],
      [3, 4],
      [4, 2],
      [2, 8],
      [5, 9],
      [5, 1],
      [1, 6],
      [6, 10],
      [3, 11],
      [3, 12],
    ],
    regionWidth: new Float64Array(13).fill(1),
    regionHeight: new Float64Array(13).fill(1),
    regionCenterX: new Float64Array(13),
    regionCenterY: new Float64Array(13),
    portAngleForRegion1: new Int32Array([
      0, 9000, 18000, 18000, 0, 0, 18000, 0, 9000, 27000, 18000, 9000, 9000,
    ]),
    portAngleForRegion2: new Int32Array([
      0, 0, 0, 0, 18000, 9000, 0, 0, 9000, 0, 0, 0, 0,
    ]),
    portX: new Float64Array(13),
    portY: new Float64Array(13),
    portZ: new Int32Array(13),
  }
  const problem: TinyHyperGraphProblem = {
    routeCount: 3,
    portSectionMask: new Int8Array(13).fill(1),
    routeStartPort: new Int32Array([0, 7, 11]),
    routeEndPort: new Int32Array([6, 10, 12]),
    routeNet: new Int32Array([0, 1, 2]),
    regionNetId: new Int32Array(13).fill(-1),
  }
  const solver = new TinyHyperGraphSolver(topology, problem)
  const addSegment = (
    regionId: RegionId,
    routeId: RouteId,
    fromPortId: PortId,
    toPortId: PortId,
  ) => {
    const routeNetId = problem.routeNet[routeId]!
    solver.state.currentRouteNetId = routeNetId
    solver.state.regionSegments[regionId]!.push([routeId, fromPortId, toPortId])
    solver.state.portAssignment[fromPortId] = routeNetId
    solver.state.portAssignment[toPortId] = routeNetId
    solver.appendSegmentToRegionCache(regionId, fromPortId, toPortId)
  }

  addSegment(0, 0, 0, 1)
  addSegment(1, 0, 1, 2)
  addSegment(2, 0, 2, 6)
  addSegment(5, 1, 7, 8)
  addSegment(1, 1, 8, 9)
  addSegment(6, 1, 9, 10)
  addSegment(3, 2, 11, 12)
  solver.state.currentRouteNetId = undefined
  solver.solved = true

  return solver
}

test("unravel solver accepts only beneficial boundary mutations", () => {
  const inputSolver = createCrossedSolvedSolver()
  const initialMaxRegionCost = getMaxRegionCost(inputSolver)
  const solver = new UnravelTinyHyperGraphSolver(inputSolver, {
    MAX_HOT_REGIONS: 0,
  })

  solver.solve()

  expect(initialMaxRegionCost).toBeGreaterThan(0)
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(getMaxRegionCost(solver)).toBe(0)
  expect(solver.stats.acceptedMutationCount).toBe(1)
  expect(solver.stats.optimized).toBe(true)
  expect(solver.getOutput().solvedRoutes).toHaveLength(2)

  const repeatedSolver = new UnravelTinyHyperGraphSolver(inputSolver, {
    MAX_HOT_REGIONS: 0,
  })
  repeatedSolver.solve()
  expect(repeatedSolver.state.regionSegments).toEqual(
    solver.state.regionSegments,
  )
})

test("routing-complexity swaps preserve boundary layers", () => {
  const inputSolver = createCrossedSolvedSolver(
    new Int32Array([0, 0, 0, 1, 0, 0]),
  )
  const solver = new UnravelTinyHyperGraphSolver(inputSolver, {
    REGION_COST_MODEL: "routing-complexity",
    MAX_HOT_REGIONS: 0,
  })

  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.stats.acceptedMutationCount).toBe(0)
  expect(solver.stats.rejectedCrossLayerSwapCount).toBeGreaterThan(0)
  expect(solver.state.regionSegments).toEqual(inputSolver.state.regionSegments)
})

test("routing-complexity includes physical trace density by default", () => {
  const inputSolver = createCrossedSolvedSolver()
  const defaultDensitySolver = new UnravelTinyHyperGraphSolver(inputSolver, {
    REGION_COST_MODEL: "routing-complexity",
    MAX_MUTATIONS: 0,
  })
  const explicitZeroDensitySolver = new UnravelTinyHyperGraphSolver(
    inputSolver,
    {
      REGION_COST_MODEL: "routing-complexity",
      TRACE_DENSITY_COST_FACTOR: 0,
      MAX_MUTATIONS: 0,
    },
  )

  expect(defaultDensitySolver.TRACE_DENSITY_COST_FACTOR).toBe(1)
  expect(explicitZeroDensitySolver.TRACE_DENSITY_COST_FACTOR).toBe(0)
  expect(defaultDensitySolver.initialSummary.totalRegionCost).toBeGreaterThan(
    explicitZeroDensitySolver.initialSummary.totalRegionCost,
  )
})

test("unravel solver preserves the input at a zero mutation limit", () => {
  const inputSolver = createCrossedSolvedSolver()
  const solver = new UnravelTinyHyperGraphSolver(inputSolver, {
    MAX_MUTATIONS: 0,
  })

  solver.solve()

  expect(getMaxRegionCost(solver)).toBe(getMaxRegionCost(inputSolver))
  expect(solver.stats.acceptedMutationCount).toBe(0)
  expect(solver.stats.optimized).toBe(false)
})

test("unravel solver replaces a route through the hottest region", () => {
  const inputSolver = createSolvedSolverWithAlternatePath()
  const solver = new UnravelTinyHyperGraphSolver(inputSolver, {
    MAX_MUTATIONS: 1,
    MAX_HOT_REGIONS: 1,
    REROUTE_CONGESTION_FACTORS: [0],
    MAX_REROUTE_SEGMENT_INCREASE: 10,
  })

  solver.solve()

  expect(getMaxRegionCost(inputSolver)).toBeGreaterThan(0)
  expect(getMaxRegionCost(solver)).toBe(0)
  expect(solver.stats.lastMutationKind).toBe("reroute")
  expect(solver.state.regionSegments[3]!.map(([routeId]) => routeId)).toEqual([
    0, 2,
  ])

  const output = solver.getOutput()
  expect(output.solvedRoutes).toHaveLength(3)
  const { topology, problem, solution } = loadSerializedHyperGraph(output)
  const replaySolver = new TinyHyperGraphSectionSolver(
    topology,
    problem,
    solution,
  ).baselineSolver
  expect(getMaxRegionCost(replaySolver)).toBe(getMaxRegionCost(solver))
})

test("unravel solver rejects a cost-improving route detour at a zero ceiling", () => {
  const inputSolver = createSolvedSolverWithAlternatePath()
  const initialMaxRegionCost = getMaxRegionCost(inputSolver)
  const initialSegmentCount = getTotalSegmentCount(inputSolver)
  const solver = new UnravelTinyHyperGraphSolver(inputSolver, {
    MAX_MUTATIONS: 1,
    MAX_HOT_REGIONS: 1,
    REROUTE_CONGESTION_FACTORS: [0],
    MAX_REROUTE_SEGMENT_INCREASE: 0,
  })

  solver.solve()

  expect(getMaxRegionCost(solver)).toBe(initialMaxRegionCost)
  expect(getTotalSegmentCount(solver)).toBe(initialSegmentCount)
  expect(solver.stats.acceptedMutationCount).toBe(0)
  expect(solver.stats.rejectedRerouteDetourCount).toBeGreaterThan(0)
})

test("unravel solver requires a completed input solve", () => {
  const inputSolver = createCrossedSolvedSolver()
  inputSolver.solved = false

  expect(() => new UnravelTinyHyperGraphSolver(inputSolver)).toThrow(
    "requires a successfully solved input solver",
  )
})
