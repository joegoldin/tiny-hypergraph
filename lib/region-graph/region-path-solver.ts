import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { MinHeap } from "../MinHeap"
import type { TinyHyperGraphProblem, TinyHyperGraphTopology } from "../core"
import {
  createRegionGraph,
  createRegionPathProblem,
  getSerializedRegionId,
  type RegionGraph,
  type RegionPathProblem,
} from "./graph"
import type { NetId, RegionId, RouteId } from "../types"
import { range } from "../utils"
import { visualizeRegionGraph } from "./visualizeRegionGraph"

export interface RegionPathSolverOptions {
  DISTANCE_TO_COST?: number
  MM_COST_FOR_FULL_BOUNDARY?: number
  MM_COST_FOR_FULL_REGION?: number
  MAX_ITERATIONS?: number
}

export interface RegionPathCandidate {
  regionId: RegionId
  prevCandidate?: RegionPathCandidate
  prevRegionId?: RegionId
  enteredThroughEdgeId?: number
  g: number
  h: number
  f: number
}

export interface RegionPathSolverOutput {
  routeCount: number
  solvedRoutes: Array<{
    routeId: RouteId
    connectionId?: string
    startRegionId: string
    endRegionId: string
    regionIds: string[]
    cost: number
  }>
}

export interface RegionPathWorkingState {
  boundaryUsage: Int32Array
  regionUsage: Int32Array
  regionAssignedRoutes: Array<RouteId[]>
  solvedRouteRegionIds: Array<RegionId[]>
  solvedRouteCosts: Float64Array
  currentRouteId: RouteId | undefined
  currentRouteNetId: NetId | undefined
  goalRegionId: RegionId
  unroutedRoutes: RouteId[]
  candidateQueue: MinHeap<RegionPathCandidate>
  candidateBestCostByRegionId: Float64Array
  candidateBestCostGenerationByRegionId: Uint32Array
  candidateBestCostGeneration: number
}

const compareCandidatesByF = (
  left: RegionPathCandidate,
  right: RegionPathCandidate,
) => left.f - right.f

export class RegionPathSolver extends BaseSolver {
  regionGraph: RegionGraph
  regionProblem: RegionPathProblem
  boundaryCapacity: Float64Array

  DISTANCE_TO_COST = 1
  MM_COST_FOR_FULL_BOUNDARY = 20
  MM_COST_FOR_FULL_REGION = 20
  override MAX_ITERATIONS = 1e6

  state: RegionPathWorkingState

  constructor(
    public topology: TinyHyperGraphTopology,
    public problem: TinyHyperGraphProblem,
    options?: RegionPathSolverOptions,
  ) {
    super()

    this.regionGraph = createRegionGraph(topology)
    this.regionProblem = createRegionPathProblem(topology, problem)
    this.boundaryCapacity = Float64Array.from(
      this.regionGraph.edges,
      (edge) =>
        edge.portIds.reduce(
          (count, portId) =>
            count + (problem.portSectionMask[portId] === 0 ? 0 : 1),
          0,
        ) || 1,
    )

    if (options?.DISTANCE_TO_COST !== undefined) {
      this.DISTANCE_TO_COST = options.DISTANCE_TO_COST
    }
    if (options?.MM_COST_FOR_FULL_BOUNDARY !== undefined) {
      this.MM_COST_FOR_FULL_BOUNDARY = options.MM_COST_FOR_FULL_BOUNDARY
    }
    if (options?.MM_COST_FOR_FULL_REGION !== undefined) {
      this.MM_COST_FOR_FULL_REGION = options.MM_COST_FOR_FULL_REGION
    }
    if (options?.MAX_ITERATIONS !== undefined) {
      this.MAX_ITERATIONS = options.MAX_ITERATIONS
    }

    this.state = {
      boundaryUsage: new Int32Array(this.regionGraph.edgeCount),
      regionUsage: new Int32Array(this.regionGraph.regionCount),
      regionAssignedRoutes: Array.from(
        { length: this.regionGraph.regionCount },
        () => [] as RouteId[],
      ),
      solvedRouteRegionIds: Array.from(
        { length: this.regionProblem.routeCount },
        () => [] as RegionId[],
      ),
      solvedRouteCosts: new Float64Array(this.regionProblem.routeCount),
      currentRouteId: undefined,
      currentRouteNetId: undefined,
      goalRegionId: -1,
      unroutedRoutes: range(this.regionProblem.routeCount),
      candidateQueue: new MinHeap([], compareCandidatesByF),
      candidateBestCostByRegionId: new Float64Array(
        this.regionGraph.regionCount,
      ),
      candidateBestCostGenerationByRegionId: new Uint32Array(
        this.regionGraph.regionCount,
      ),
      candidateBestCostGeneration: 1,
    }

    this.updateStats()
  }

  override _setup() {}

  override _step() {
    const { state, regionProblem } = this

    if (state.currentRouteId === undefined) {
      if (state.unroutedRoutes.length === 0) {
        this.solved = true
        this.updateStats()
        return
      }

      const nextRouteId = state.unroutedRoutes.shift()
      if (nextRouteId === undefined) {
        this.failed = true
        this.error = "Failed to pull the next route from the region-route queue"
        return
      }

      state.currentRouteId = nextRouteId
      state.currentRouteNetId = regionProblem.routeNet[nextRouteId]
      state.goalRegionId = regionProblem.routeEndRegion[nextRouteId]

      const startRegionId = regionProblem.routeStartRegion[nextRouteId]
      if (startRegionId === undefined || state.goalRegionId === undefined) {
        this.failed = true
        this.error = `Route ${nextRouteId} is missing region endpoints`
        return
      }

      state.candidateQueue.clear()
      this.resetCandidateBestCosts()

      const startCost = this.computeRegionEntryCost(startRegionId)
      const startHeuristic = this.computeDistanceToGoal(startRegionId)
      const startCandidate: RegionPathCandidate = {
        regionId: startRegionId,
        g: startCost,
        h: startHeuristic,
        f: startCost + startHeuristic,
      }

      this.setCandidateBestCost(startRegionId, startCost)
      state.candidateQueue.queue(startCandidate)
      this.updateStats()

      if (startRegionId === state.goalRegionId) {
        this.onPathFound(startCandidate)
        return
      }
    }

    const currentCandidate = state.candidateQueue.dequeue()

    if (!currentCandidate) {
      this.failed = true
      this.error = `No region path found for route ${state.currentRouteId}`
      return
    }

    if (
      currentCandidate.g >
      this.getCandidateBestCost(currentCandidate.regionId) + Number.EPSILON
    ) {
      return
    }

    if (currentCandidate.regionId === state.goalRegionId) {
      this.onPathFound(currentCandidate)
      return
    }

    if (this.isRegionReservedForDifferentNet(currentCandidate.regionId)) {
      return
    }

    for (const edge of this.regionGraph.incidentEdges[
      currentCandidate.regionId
    ] ?? []) {
      const nextRegionId =
        edge.regionIdA === currentCandidate.regionId
          ? edge.regionIdB
          : edge.regionIdA

      if (this.isRegionReservedForDifferentNet(nextRegionId)) {
        continue
      }

      const g =
        currentCandidate.g +
        edge.centerDistance * this.DISTANCE_TO_COST +
        this.computeBoundaryTraversalCost(edge.edgeId) +
        this.computeRegionEntryCost(nextRegionId)
      if (!Number.isFinite(g)) {
        continue
      }

      if (g >= this.getCandidateBestCost(nextRegionId) - Number.EPSILON) {
        continue
      }

      const h = this.computeDistanceToGoal(nextRegionId)
      const nextCandidate: RegionPathCandidate = {
        regionId: nextRegionId,
        prevRegionId: currentCandidate.regionId,
        prevCandidate: currentCandidate,
        enteredThroughEdgeId: edge.edgeId,
        g,
        h,
        f: g + h,
      }

      this.setCandidateBestCost(nextRegionId, g)
      state.candidateQueue.queue(nextCandidate)
    }
  }

  resetCandidateBestCosts() {
    const { state } = this

    if (state.candidateBestCostGeneration === 0xffffffff) {
      state.candidateBestCostGenerationByRegionId.fill(0)
      state.candidateBestCostGeneration = 1
      return
    }

    state.candidateBestCostGeneration += 1
  }

  getCandidateBestCost(regionId: RegionId) {
    const { state } = this

    return state.candidateBestCostGenerationByRegionId[regionId] ===
      state.candidateBestCostGeneration
      ? state.candidateBestCostByRegionId[regionId]
      : Number.POSITIVE_INFINITY
  }

  setCandidateBestCost(regionId: RegionId, bestCost: number) {
    const { state } = this

    state.candidateBestCostGenerationByRegionId[regionId] =
      state.candidateBestCostGeneration
    state.candidateBestCostByRegionId[regionId] = bestCost
  }

  isRegionReservedForDifferentNet(regionId: RegionId) {
    const reservedNetId = this.regionProblem.regionNetId[regionId]
    return (
      reservedNetId !== -1 && reservedNetId !== this.state.currentRouteNetId
    )
  }

  computeRegionEntryCost(regionId: RegionId) {
    const nextUsage = this.state.regionUsage[regionId] + 1
    const regionCapacity = this.regionGraph.regionCapacity[regionId]
    return (nextUsage / regionCapacity) * this.MM_COST_FOR_FULL_REGION
  }

  computeBoundaryTraversalCost(edgeId: number) {
    const edge = this.regionGraph.edges[edgeId]
    if (!edge) return Number.POSITIVE_INFINITY

    const nextUsage = this.state.boundaryUsage[edgeId] + 1
    return (
      (nextUsage / this.boundaryCapacity[edgeId]) *
      this.MM_COST_FOR_FULL_BOUNDARY
    )
  }

  computeDistanceToGoal(regionId: RegionId) {
    const goalRegionId = this.state.goalRegionId
    if (goalRegionId < 0) return 0

    const dx =
      this.regionGraph.regionCenterX[regionId] -
      this.regionGraph.regionCenterX[goalRegionId]
    const dy =
      this.regionGraph.regionCenterY[regionId] -
      this.regionGraph.regionCenterY[goalRegionId]
    return Math.hypot(dx, dy) * this.DISTANCE_TO_COST
  }

  getSolvedRegionPath(finalCandidate: RegionPathCandidate): RegionId[] {
    const regionPath: RegionId[] = []
    let cursor: RegionPathCandidate | undefined = finalCandidate

    while (cursor) {
      regionPath.unshift(cursor.regionId)
      cursor = cursor.prevCandidate
    }

    return regionPath
  }

  onPathFound(finalCandidate: RegionPathCandidate) {
    const { state } = this
    const currentRouteId = state.currentRouteId

    if (currentRouteId === undefined) {
      return
    }

    const solvedRegionPath = this.getSolvedRegionPath(finalCandidate)
    state.solvedRouteRegionIds[currentRouteId] = solvedRegionPath
    state.solvedRouteCosts[currentRouteId] = finalCandidate.g

    let cursor: RegionPathCandidate | undefined = finalCandidate
    while (cursor) {
      if (cursor.enteredThroughEdgeId !== undefined) {
        state.boundaryUsage[cursor.enteredThroughEdgeId] += 1
      }
      cursor = cursor.prevCandidate
    }

    for (const regionId of solvedRegionPath) {
      state.regionUsage[regionId] += 1
      state.regionAssignedRoutes[regionId]!.push(currentRouteId)
    }

    state.currentRouteId = undefined
    state.currentRouteNetId = undefined
    state.goalRegionId = -1
    state.candidateQueue.clear()

    this.updateStats()
  }

  updateStats() {
    const { state, regionGraph } = this

    let maxRegionUsage = 0
    let maxUtilization = 0
    let maxBoundaryUtilization = 0

    for (const edge of regionGraph.edges) {
      maxBoundaryUtilization = Math.max(
        maxBoundaryUtilization,
        state.boundaryUsage[edge.edgeId] /
          this.boundaryCapacity[edge.edgeId],
      )
    }

    for (let regionId = 0; regionId < regionGraph.regionCount; regionId++) {
      const usage = state.regionUsage[regionId]
      const utilization = usage / regionGraph.regionCapacity[regionId]
      maxRegionUsage = Math.max(maxRegionUsage, usage)
      maxUtilization = Math.max(maxUtilization, utilization)
    }

    this.stats = {
      ...this.stats,
      routeCount: this.regionProblem.routeCount,
      regionCount: regionGraph.regionCount,
      edgeCount: regionGraph.edgeCount,
      solvedRouteCount: state.solvedRouteRegionIds.filter(
        (regionPath) => regionPath.length > 0,
      ).length,
      currentRouteId: state.currentRouteId,
      currentGoalRegionId:
        state.goalRegionId >= 0 ? state.goalRegionId : undefined,
      openCandidateCount: state.candidateQueue.length,
      maxRegionUsage,
      maxUtilization,
      maxBoundaryUtilization,
    }
  }

  override visualize(): GraphicsObject {
    return visualizeRegionGraph(this)
  }

  override getOutput(): RegionPathSolverOutput {
    return {
      routeCount: this.regionProblem.routeCount,
      solvedRoutes: this.state.solvedRouteRegionIds.map(
        (regionPath, routeId) => {
          const routeMetadata = this.regionProblem.routeMetadata?.[routeId] as
            | { connectionId?: unknown }
            | undefined
          return {
            routeId,
            connectionId:
              typeof routeMetadata?.connectionId === "string"
                ? routeMetadata.connectionId
                : undefined,
            startRegionId: getSerializedRegionId(
              this.regionGraph,
              this.regionProblem.routeStartRegion[routeId],
            ),
            endRegionId: getSerializedRegionId(
              this.regionGraph,
              this.regionProblem.routeEndRegion[routeId],
            ),
            regionIds: regionPath.map((regionId) =>
              getSerializedRegionId(this.regionGraph, regionId),
            ),
            cost: this.state.solvedRouteCosts[routeId] ?? 0,
          }
        },
      ),
    }
  }
}
