import { expect, test } from "bun:test"
import {
  type TinyHyperGraphProblem,
  TinyHyperGraphSolver,
  type TinyHyperGraphTopology,
} from "lib/index"

const createSolver = (useSparseStorage = false) => {
  const topology: TinyHyperGraphTopology = {
    portCount: 3,
    regionCount: 100,
    regionIncidentPorts: Array.from({ length: 100 }, () => []),
    incidentPortRegion: [[2, 7], [7, 9], [9]],
    regionWidth: new Float64Array(100).fill(1),
    regionHeight: new Float64Array(100).fill(1),
    regionCenterX: new Float64Array(100),
    regionCenterY: new Float64Array(100),
    portAngleForRegion1: new Int32Array(3),
    portAngleForRegion2: new Int32Array(3),
    portX: new Float64Array(3),
    portY: new Float64Array(3),
    portZ: new Int32Array(3),
  }
  const problem: TinyHyperGraphProblem = {
    routeCount: 0,
    portSectionMask: new Int8Array(3),
    routeStartPort: new Int32Array(0),
    routeEndPort: new Int32Array(0),
    routeNet: new Int32Array(0),
    regionNetId: new Int32Array(100).fill(-1),
  }

  return new TinyHyperGraphSolver(topology, problem, {
    USE_SPARSE_CANDIDATE_STORAGE: useSparseStorage,
    STATIC_REACHABILITY_PRECHECK: false,
  })
}

test("sizes dense candidate state by incident hops instead of all regions", () => {
  const solver = createSolver()

  expect(solver.state.candidateBestCostByHopId).toBeInstanceOf(Float64Array)
  expect(solver.state.candidateBestCostGenerationByHopId).toBeInstanceOf(
    Uint32Array,
  )
  expect(solver.state.candidateBestCostByHopId).toHaveLength(6)
  expect(solver.state.candidateBestCostGenerationByHopId).toHaveLength(6)
})

test("keeps incident slots and non-incident fallback hops distinct", () => {
  for (const useSparseStorage of [false, true]) {
    const solver = createSolver(useSparseStorage)
    const firstIncidentHop = solver.getHopId(0, 2)
    const secondIncidentHop = solver.getHopId(0, 7)
    const nonIncidentHop = solver.getHopId(0, 99)

    solver.setCandidateBestCost(firstIncidentHop, 1)
    solver.setCandidateBestCost(secondIncidentHop, 2)
    solver.setCandidateBestCost(nonIncidentHop, 3)

    expect(solver.getCandidateBestCost(firstIncidentHop)).toBe(1)
    expect(solver.getCandidateBestCost(secondIncidentHop)).toBe(2)
    expect(solver.getCandidateBestCost(nonIncidentHop)).toBe(3)

    solver.resetCandidateBestCosts()

    expect(solver.getCandidateBestCost(firstIncidentHop)).toBe(Infinity)
    expect(solver.getCandidateBestCost(secondIncidentHop)).toBe(Infinity)
    expect(solver.getCandidateBestCost(nonIncidentHop)).toBe(Infinity)
  }
})
