import {
  createEmptyRegionIntersectionCache,
  getTinyHyperGraphSolverOptions,
  type RegionCostSummary,
  type TinyHyperGraphProblem,
  TinyHyperGraphSolver,
  type TinyHyperGraphSolverOptions,
} from "./core"
import { computeRoutingRiskRegionCost } from "./computeRegionCost"
import { classifyIntersectionLayerMasks } from "./countNewIntersections"
import type {
  PortId,
  RegionId,
  RegionIntersectionCache,
  RouteId,
} from "./types"

const COST_EPSILON = 1e-9

interface BoundaryPortSlot {
  portId: PortId
  routeId?: RouteId
  region1Id: RegionId
  region2Id: RegionId
}

interface PortOccurrence {
  regionId: RegionId
  routeId: RouteId
}

interface UnravelRegionCostSummary extends RegionCostSummary {
  maxRegionSegmentCount: number
  squaredRegionSegmentCount: number
  /** Downstream high-density crossing-risk metrics for composite cost plateaus. */
  maxRoutingRisk: number
  squaredRoutingRisk: number
  totalRoutingRisk: number
}

interface SwapMutation {
  kind: "swap"
  port1Id: PortId
  port2Id: PortId
  route1Id?: RouteId
  route2Id?: RouteId
  region1Id: RegionId
  region2Id: RegionId
  region1Cost: number
  region2Cost: number
  summary: UnravelRegionCostSummary
}

interface RerouteMutation {
  kind: "reroute"
  routeId: RouteId
  congestionFactor: number
  replacementPath: ReplacementPathSegment[]
  replacementState: {
    portAssignment: Int32Array
    regionSegments: Array<[RouteId, PortId, PortId][]>
    regionIntersectionCaches: RegionIntersectionCache[]
  }
  summary: UnravelRegionCostSummary
}

interface ReplacementPathSegment {
  regionId: RegionId
  fromPortId: PortId
  toPortId: PortId
}

interface CachedReroutePath {
  routeId: RouteId
  congestionFactor: number
  replacementPath: ReplacementPathSegment[]
}

export interface UnravelTinyHyperGraphSolverOptions
  extends TinyHyperGraphSolverOptions {
  /** Optional hard cap across all accepted mutations. */
  MAX_MUTATIONS?: number
  /** Maximum whole-route replacements after the initial untwist descent. */
  MAX_REROUTE_MUTATIONS?: number
  /** Number of the most expensive regions whose routes are considered. */
  MAX_HOT_REGIONS?: number
  /** Iteration cap for each single-route replacement search. */
  REROUTE_MAX_ITERATIONS?: number
  /** Maximum routes from the hot regions evaluated per mutation. */
  MAX_REROUTE_ROUTES?: number
  /** Congestion multipliers explored for each route replacement. */
  REROUTE_CONGESTION_FACTORS?: number[]
  /** Optional maximum extra region segments for an individual rerouted route. */
  MAX_REROUTE_SEGMENT_INCREASE?: number
}

const cloneRegionIntersectionCache = (
  cache: RegionIntersectionCache,
): RegionIntersectionCache => ({
  netIds: new Int32Array(cache.netIds),
  lesserAngles: new Int32Array(cache.lesserAngles),
  greaterAngles: new Int32Array(cache.greaterAngles),
  layerMasks: new Int32Array(cache.layerMasks),
  existingCrossingLayerIntersections: cache.existingCrossingLayerIntersections,
  existingSameLayerIntersections: cache.existingSameLayerIntersections,
  existingEntryExitLayerChanges: cache.existingEntryExitLayerChanges,
  existingRegionCost: cache.existingRegionCost,
  existingSegmentCount: cache.existingSegmentCount,
})

const compareRegionCostSummaries = (
  left: UnravelRegionCostSummary,
  right: UnravelRegionCostSummary,
) => {
  if (Math.abs(left.maxRegionCost - right.maxRegionCost) > COST_EPSILON) {
    return left.maxRegionCost - right.maxRegionCost
  }

  if (left.maxRegionSegmentCount !== right.maxRegionSegmentCount) {
    return left.maxRegionSegmentCount - right.maxRegionSegmentCount
  }

  if (left.squaredRegionSegmentCount !== right.squaredRegionSegmentCount) {
    return left.squaredRegionSegmentCount - right.squaredRegionSegmentCount
  }

  if (Math.abs(left.totalRegionCost - right.totalRegionCost) > COST_EPSILON) {
    return left.totalRegionCost - right.totalRegionCost
  }

  if (Math.abs(left.maxRoutingRisk - right.maxRoutingRisk) > COST_EPSILON) {
    return left.maxRoutingRisk - right.maxRoutingRisk
  }

  if (
    Math.abs(left.squaredRoutingRisk - right.squaredRoutingRisk) > COST_EPSILON
  ) {
    return left.squaredRoutingRisk - right.squaredRoutingRisk
  }

  if (Math.abs(left.totalRoutingRisk - right.totalRoutingRisk) > COST_EPSILON) {
    return left.totalRoutingRisk - right.totalRoutingRisk
  }

  return 0
}

const isParetoImprovement = (
  candidate: UnravelRegionCostSummary,
  current: UnravelRegionCostSummary,
) => {
  if (candidate.maxRegionCost < current.maxRegionCost - COST_EPSILON) {
    return true
  }
  if (candidate.maxRegionCost > current.maxRegionCost + COST_EPSILON) {
    return false
  }

  const noWorse =
    candidate.totalRegionCost <= current.totalRegionCost + COST_EPSILON &&
    candidate.maxRegionSegmentCount <= current.maxRegionSegmentCount &&
    candidate.squaredRegionSegmentCount <= current.squaredRegionSegmentCount &&
    candidate.maxRoutingRisk <= current.maxRoutingRisk + COST_EPSILON &&
    candidate.squaredRoutingRisk <= current.squaredRoutingRisk + COST_EPSILON &&
    candidate.totalRoutingRisk <= current.totalRoutingRisk + COST_EPSILON
  if (!noWorse) return false

  return (
    candidate.totalRegionCost < current.totalRegionCost - COST_EPSILON ||
    candidate.maxRegionSegmentCount < current.maxRegionSegmentCount ||
    candidate.squaredRegionSegmentCount < current.squaredRegionSegmentCount ||
    candidate.maxRoutingRisk < current.maxRoutingRisk - COST_EPSILON ||
    candidate.squaredRoutingRisk < current.squaredRoutingRisk - COST_EPSILON ||
    candidate.totalRoutingRisk < current.totalRoutingRisk - COST_EPSILON
  )
}

const createWholeGraphProblem = (
  problem: TinyHyperGraphProblem,
  portCount: number,
): TinyHyperGraphProblem => ({
  routeCount: problem.routeCount,
  portSectionMask: new Int8Array(portCount).fill(1),
  routeMetadata: problem.routeMetadata,
  routeStartPort: new Int32Array(problem.routeStartPort),
  routeEndPort: new Int32Array(problem.routeEndPort),
  routeNet: problem.routeNet,
  regionNetId: problem.regionNetId,
  portPenalty: problem.portPenalty,
})

const getUnravelCoreOptions = (
  inputSolver: TinyHyperGraphSolver,
  options?: UnravelTinyHyperGraphSolverOptions,
): TinyHyperGraphSolverOptions => ({
  ...getTinyHyperGraphSolverOptions(inputSolver),
  STATIC_REACHABILITY_PRECHECK: false,
  ...options,
})

class SingleRouteReplacementSolver extends TinyHyperGraphSolver {
  replacementRouteSegmentCount = 0
  private readonly writableRegionMask: Int8Array

  constructor(inputSolver: TinyHyperGraphSolver, maxIterations: number) {
    super(
      inputSolver.topology,
      createWholeGraphProblem(
        inputSolver.problem,
        inputSolver.topology.portCount,
      ),
      {
        ...getTinyHyperGraphSolverOptions(inputSolver),
        // Candidate generation should remain able to cross a currently dense
        // region when that produces a globally shorter route. The completed
        // state is rescored with the optimizer's full physical objective.
        TRACE_DENSITY_COST_FACTOR: 0,
        STATIC_REACHABILITY_PRECHECK: false,
        ACCEPT_BEST_SOLUTION_ON_TIMEOUT: false,
        GREEDY_FINAL_ROUTE_ITERS: 0,
        RIP_THRESHOLD_RAMP_ATTEMPTS: 0,
        USE_LAZY_ROUTE_HEURISTIC: true,
        MAX_ITERATIONS: maxIterations,
      },
    )

    this.writableRegionMask = new Int8Array(this.topology.regionCount)
  }

  resetForRoute(
    inputSolver: TinyHyperGraphSolver,
    routeIdToReplace: RouteId,
    congestionFactor: number,
  ) {
    this.TRACE_DENSITY_COST_FACTOR = 0
    this.solved = false
    this.failed = false
    this.error = null
    this.iterations = 0
    this.progress = 0
    this.activeSubSolver = null
    this.failedSubSolvers = []
    this.timeToSolve = undefined
    this.stats = {}
    this._setupDone = false
    this.bestSolvedStateSnapshot = undefined
    this.bestSolvedStateSummary = undefined
    this.routeAttemptCountByRouteId.fill(0)
    this.routeSuccessCountByRouteId.fill(0)
    this.replacementRouteSegmentCount = 0
    this.writableRegionMask.fill(0)

    this.state.portAssignment.set(inputSolver.state.portAssignment)
    this.state.regionSegments = inputSolver.state.regionSegments.slice()
    this.state.regionIntersectionCaches =
      inputSolver.state.regionIntersectionCaches.slice()
    const removedPortIds = new Set<PortId>()

    for (
      let regionId = 0;
      regionId < inputSolver.state.regionSegments.length;
      regionId++
    ) {
      const inputSegments = inputSolver.state.regionSegments[regionId]!
      if (!inputSegments.some(([routeId]) => routeId === routeIdToReplace)) {
        continue
      }
      this.writableRegionMask[regionId] = 1
      this.state.regionSegments[regionId] = inputSegments.filter(
        ([routeId, fromPortId, toPortId]) => {
          if (routeId !== routeIdToReplace) return true
          removedPortIds.add(fromPortId)
          removedPortIds.add(toPortId)
          return false
        },
      )
      this.rebuildRegionCache(regionId)
    }

    for (const portId of removedPortIds) {
      this.state.portAssignment[portId] = -1
      for (const regionId of this.topology.incidentPortRegion[portId] ?? []) {
        const retainingSegment = this.state.regionSegments[regionId]!.find(
          ([, fromPortId, toPortId]) =>
            fromPortId === portId || toPortId === portId,
        )
        if (retainingSegment) {
          this.state.portAssignment[portId] =
            this.problem.routeNet[retainingSegment[0]]!
          break
        }
      }
    }

    this.state.currentRouteId = undefined
    this.state.currentRouteNetId = undefined
    this.state.unroutedRoutes = [routeIdToReplace]
    this.state.candidateQueue.clear()
    this.resetCandidateBestCosts()
    this.state.goalPortId = -1
    for (let regionId = 0; regionId < this.topology.regionCount; regionId++) {
      this.state.regionCongestionCost[regionId] =
        inputSolver.state.regionIntersectionCaches[regionId]!
          .existingRegionCost * congestionFactor
    }
  }

  override onAllRoutesRouted() {
    this.state.currentRouteId = undefined
    this.state.currentRouteNetId = undefined
    this.solved = true
  }

  override onPathFound(
    finalCandidate: Parameters<TinyHyperGraphSolver["onPathFound"]>[0],
  ) {
    const solvedSegments = this.getSolvedPathSegments(finalCandidate)
    this.replacementRouteSegmentCount = solvedSegments.length
    const touchedRegionIds = new Set<RegionId>()
    for (const { regionId } of solvedSegments) {
      touchedRegionIds.add(regionId)
      if (this.writableRegionMask[regionId] === 0) {
        this.state.regionSegments[regionId] = [
          ...this.state.regionSegments[regionId]!,
        ]
        this.writableRegionMask[regionId] = 1
      }
    }
    super.onPathFound(finalCandidate)

    // Serialized solutions are replayed in route-id order. Keep the same
    // canonical order here because angular interval accumulation is not
    // commutative for wraparound segments, and rebuild only the regions that
    // the replacement route actually touched.
    for (const regionId of touchedRegionIds) {
      this.state.regionSegments[regionId]!.sort(
        (left, right) => left[0] - right[0],
      )
      this.rebuildRegionCache(regionId)
    }
  }

  getReplacementState() {
    return {
      portAssignment: new Int32Array(this.state.portAssignment),
      regionSegments: this.state.regionSegments,
      regionIntersectionCaches: this.state.regionIntersectionCaches,
    }
  }

  getReplacementPath(routeId: RouteId): ReplacementPathSegment[] {
    const path: ReplacementPathSegment[] = []
    for (
      let regionId = 0;
      regionId < this.state.regionSegments.length;
      regionId++
    ) {
      for (const [segmentRouteId, fromPortId, toPortId] of this.state
        .regionSegments[regionId]!) {
        if (segmentRouteId !== routeId) continue
        path.push({ regionId, fromPortId, toPortId })
      }
    }
    return path
  }

  loadReplacementPath(
    inputSolver: TinyHyperGraphSolver,
    routeId: RouteId,
    congestionFactor: number,
    path: ReplacementPathSegment[],
  ): boolean {
    this.resetForRoute(inputSolver, routeId, congestionFactor)
    const routeNetId = this.problem.routeNet[routeId]!
    this.state.currentRouteId = routeId
    this.state.currentRouteNetId = routeNetId
    const touchedRegionIds = new Set<RegionId>()

    for (const { regionId, fromPortId, toPortId } of path) {
      if (this.isRegionReservedForDifferentNet(regionId)) return false
      for (const portId of [fromPortId, toPortId]) {
        const assignedNetId = this.state.portAssignment[portId]!
        if (assignedNetId !== -1 && assignedNetId !== routeNetId) return false
      }

      if (this.writableRegionMask[regionId] === 0) {
        this.state.regionSegments[regionId] = [
          ...this.state.regionSegments[regionId]!,
        ]
        this.writableRegionMask[regionId] = 1
      }
      this.state.regionSegments[regionId]!.push([routeId, fromPortId, toPortId])
      this.state.portAssignment[fromPortId] = routeNetId
      this.state.portAssignment[toPortId] = routeNetId
      touchedRegionIds.add(regionId)
    }

    for (const regionId of touchedRegionIds) {
      this.state.regionSegments[regionId]!.sort(
        (left, right) => left[0] - right[0],
      )
      this.rebuildRegionCache(regionId)
    }
    this.replacementRouteSegmentCount = path.length
    this.solved = true
    return true
  }

  rescoreForOptimizer(inputSolver: TinyHyperGraphSolver) {
    this.TRACE_DENSITY_COST_FACTOR = inputSolver.TRACE_DENSITY_COST_FACTOR
    this.REGION_COST_MODEL = inputSolver.REGION_COST_MODEL
    for (let regionId = 0; regionId < this.topology.regionCount; regionId++) {
      this.rebuildRegionCache(regionId)
    }
  }

  private rebuildRegionCache(regionId: RegionId) {
    this.state.regionSegments[regionId]!.sort(
      (left, right) => left[0] - right[0],
    )
    this.state.regionIntersectionCaches[regionId] =
      createEmptyRegionIntersectionCache()
    for (const [routeId, fromPortId, toPortId] of this.state.regionSegments[
      regionId
    ]!) {
      this.state.currentRouteId = routeId
      this.state.currentRouteNetId = this.problem.routeNet[routeId]
      this.appendSegmentToRegionCache(regionId, fromPortId, toPortId)
    }
    this.state.currentRouteId = undefined
    this.state.currentRouteNetId = undefined
  }

  override onOutOfCandidates() {
    this.failed = true
    this.error = "No replacement path was found for the selected route"
  }
}

/**
 * Improves a solved hypergraph with alternating boundary-port swaps and
 * graph-wide route replacements. Boundary mutations change both sides
 * together, and replacement candidates retain every other route. Peak-cost
 * reductions are always accepted; moves on a peak plateau must improve the
 * remaining physical objectives without worsening any of them.
 */
export class UnravelTinyHyperGraphSolver extends TinyHyperGraphSolver {
  MAX_MUTATIONS = Number.POSITIVE_INFINITY
  MAX_REROUTE_MUTATIONS = Number.POSITIVE_INFINITY
  MAX_HOT_REGIONS = Number.POSITIVE_INFINITY
  REROUTE_MAX_ITERATIONS = 10_000
  MAX_REROUTE_ROUTES = Number.POSITIVE_INFINITY
  // The core path cost already includes the exact marginal region cost.
  // Adding multiples of existing congestion produces a heuristic portfolio,
  // repeats the same A* work, and can select paths that do not minimize the
  // optimizer's objective. Search the exact marginal objective once.
  REROUTE_CONGESTION_FACTORS = [0]
  MAX_REROUTE_SEGMENT_INCREASE = Number.POSITIVE_INFINITY

  readonly inputSolver: TinyHyperGraphSolver
  initialSummary: UnravelRegionCostSummary
  currentSummary: UnravelRegionCostSummary
  acceptedMutationCount = 0
  acceptedSwapMutationCount = 0
  acceptedRerouteMutationCount = 0
  evaluatedMutationCount = 0
  rejectedRerouteDetourCount = 0
  rejectedRerouteLayerChangeCount = 0
  rejectedCrossLayerSwapCount = 0
  prunedRerouteSearchCount = 0
  rerouteSearchIterationCount = 0
  rerouteSearchCount = 0
  reusedRerouteCandidateCount = 0

  private readonly endpointPortMask: Int8Array
  private readonly initialRouteSegmentCounts: Int32Array
  private readonly routingRiskOwnerByRouteId: Int32Array
  private routeReplacementSolver?: SingleRouteReplacementSolver
  private pendingReroutePaths: CachedReroutePath[] = []
  private optimizationPhase: "initial_untwist" | "reroute" | "final_untwist" =
    "initial_untwist"
  private reachedRerouteLimit = false

  constructor(
    inputSolver: TinyHyperGraphSolver,
    options?: UnravelTinyHyperGraphSolverOptions,
  ) {
    if (!inputSolver.solved || inputSolver.failed) {
      throw new Error(
        "UnravelTinyHyperGraphSolver requires a successfully solved input solver",
      )
    }

    super(
      inputSolver.topology,
      inputSolver.problem,
      getUnravelCoreOptions(inputSolver, options),
    )
    this.inputSolver = inputSolver
    if (options?.MAX_MUTATIONS !== undefined) {
      this.MAX_MUTATIONS = Math.max(0, Math.floor(options.MAX_MUTATIONS))
    }
    if (options?.MAX_REROUTE_MUTATIONS !== undefined) {
      this.MAX_REROUTE_MUTATIONS = Math.max(
        0,
        Math.floor(options.MAX_REROUTE_MUTATIONS),
      )
    }
    if (options?.MAX_HOT_REGIONS !== undefined) {
      this.MAX_HOT_REGIONS = Math.max(0, Math.floor(options.MAX_HOT_REGIONS))
    }
    if (options?.REROUTE_MAX_ITERATIONS !== undefined) {
      this.REROUTE_MAX_ITERATIONS = Math.max(
        1,
        Math.floor(options.REROUTE_MAX_ITERATIONS),
      )
    }
    if (options?.MAX_REROUTE_ROUTES !== undefined) {
      this.MAX_REROUTE_ROUTES = Math.max(
        0,
        Math.floor(options.MAX_REROUTE_ROUTES),
      )
    }
    if (options?.REROUTE_CONGESTION_FACTORS !== undefined) {
      this.REROUTE_CONGESTION_FACTORS = [...options.REROUTE_CONGESTION_FACTORS]
        .filter((factor) => Number.isFinite(factor) && factor >= 0)
        .sort((left, right) => left - right)
    }
    if (options?.MAX_REROUTE_SEGMENT_INCREASE !== undefined) {
      this.MAX_REROUTE_SEGMENT_INCREASE = Math.max(
        0,
        Math.floor(options.MAX_REROUTE_SEGMENT_INCREASE),
      )
    }
    this.state.portAssignment = new Int32Array(inputSolver.state.portAssignment)
    this.state.regionSegments = inputSolver.state.regionSegments.map(
      (segments) =>
        segments.map(
          ([routeId, fromPortId, toPortId]) =>
            [routeId, fromPortId, toPortId] as [RouteId, PortId, PortId],
        ),
    )
    this.state.regionIntersectionCaches =
      inputSolver.state.regionIntersectionCaches.map(
        cloneRegionIntersectionCache,
      )
    this.state.regionCongestionCost = new Float64Array(
      inputSolver.state.regionCongestionCost,
    )
    this.state.currentRouteId = undefined
    this.state.currentRouteNetId = undefined
    this.state.unroutedRoutes = []
    this.state.candidateQueue.clear()
    this.resetCandidateBestCosts()
    this.state.goalPortId = -1

    // Serialized solutions replay routes in route-id order. The legacy chord
    // predicate has endpoint-equality semantics that depend on insertion order,
    // so keep the optimizer's caches in that same canonical order. Otherwise a
    // swap can appear cheap internally and become expensive after getOutput()
    // is loaded by the next pipeline stage.
    for (let regionId = 0; regionId < this.topology.regionCount; regionId++) {
      this.rebuildRegionCache(regionId)
    }

    this.endpointPortMask = new Int8Array(this.topology.portCount)
    this.initialRouteSegmentCounts = new Int32Array(this.problem.routeCount)
    this.routingRiskOwnerByRouteId = new Int32Array(this.problem.routeCount)
    const routingRiskOwnerIdByName = new Map<string, number>()
    for (let routeId = 0; routeId < this.problem.routeCount; routeId++) {
      const metadata = this.problem.routeMetadata?.[routeId] as
        | {
            connectionId?: unknown
            simpleRouteConnection?: { name?: unknown }
          }
        | undefined
      const ownerName =
        typeof metadata?.simpleRouteConnection?.name === "string"
          ? metadata.simpleRouteConnection.name
          : typeof metadata?.connectionId === "string"
            ? metadata.connectionId
            : `route-${routeId}`
      let ownerId = routingRiskOwnerIdByName.get(ownerName)
      if (ownerId === undefined) {
        ownerId = routingRiskOwnerIdByName.size
        routingRiskOwnerIdByName.set(ownerName, ownerId)
      }
      this.routingRiskOwnerByRouteId[routeId] = ownerId
      this.endpointPortMask[this.problem.routeStartPort[routeId]!] = 1
      this.endpointPortMask[this.problem.routeEndPort[routeId]!] = 1
      this.initialRouteSegmentCounts[routeId] = this.getRouteSegmentCount(
        inputSolver,
        routeId,
      )
    }

    this.initialSummary = this.summarizeCurrentState()
    this.currentSummary = { ...this.initialSummary }
  }

  override _setup() {
    this.stats = {
      ...this.stats,
      initialMaxRegionCost: this.initialSummary.maxRegionCost,
      initialTotalRegionCost: this.initialSummary.totalRegionCost,
      finalMaxRegionCost: this.currentSummary.maxRegionCost,
      finalTotalRegionCost: this.currentSummary.totalRegionCost,
      acceptedMutationCount: 0,
      acceptedSwapMutationCount: 0,
      acceptedRerouteMutationCount: 0,
      evaluatedMutationCount: 0,
      rejectedRerouteDetourCount: 0,
      rejectedRerouteLayerChangeCount: 0,
      rejectedCrossLayerSwapCount: 0,
      prunedRerouteSearchCount: 0,
      rerouteSearchIterationCount: 0,
      rerouteSearchCount: 0,
      reusedRerouteCandidateCount: 0,
    }

    if (this.MAX_MUTATIONS === 0) {
      this.finishOptimization("mutation_limit")
    }
  }

  override _step() {
    if (this.acceptedMutationCount >= this.MAX_MUTATIONS) {
      this.finishOptimization("mutation_limit")
      return
    }

    // Exhaust the cheap local untwist neighborhood before changing a whole
    // route, and normalize again after every accepted replacement. Comparing
    // reroutes from locally untwisted states avoids letting a temporary port
    // ordering artifact steer the next global search.
    let mutation: SwapMutation | RerouteMutation | undefined
    while (!mutation) {
      if (this.optimizationPhase === "initial_untwist") {
        mutation = this.findBestSwapMutation()
        if (!mutation) this.optimizationPhase = "reroute"
        continue
      }

      if (this.optimizationPhase === "reroute") {
        if (this.acceptedRerouteMutationCount >= this.MAX_REROUTE_MUTATIONS) {
          this.reachedRerouteLimit = true
          this.optimizationPhase = "final_untwist"
          continue
        }
        mutation = this.findBestRerouteMutation()
        if (!mutation) this.optimizationPhase = "final_untwist"
        continue
      }

      mutation = this.findBestSwapMutation()
      if (!mutation) {
        this.finishOptimization(
          this.reachedRerouteLimit ? "reroute_limit" : "local_optimum",
        )
        return
      }
    }

    if (mutation.kind === "swap") {
      this.applySwapMutation(mutation)
      this.acceptedSwapMutationCount += 1
    } else {
      this.applyRerouteMutation(mutation)
      this.acceptedRerouteMutationCount += 1
      this.optimizationPhase = "initial_untwist"
    }
    this.acceptedMutationCount += 1
    this.currentSummary = mutation.summary
    this.stats = {
      ...this.stats,
      finalMaxRegionCost: this.currentSummary.maxRegionCost,
      finalTotalRegionCost: this.currentSummary.totalRegionCost,
      acceptedMutationCount: this.acceptedMutationCount,
      acceptedSwapMutationCount: this.acceptedSwapMutationCount,
      acceptedRerouteMutationCount: this.acceptedRerouteMutationCount,
      evaluatedMutationCount: this.evaluatedMutationCount,
      rejectedRerouteDetourCount: this.rejectedRerouteDetourCount,
      rejectedRerouteLayerChangeCount: this.rejectedRerouteLayerChangeCount,
      rejectedCrossLayerSwapCount: this.rejectedCrossLayerSwapCount,
      prunedRerouteSearchCount: this.prunedRerouteSearchCount,
      rerouteSearchIterationCount: this.rerouteSearchIterationCount,
      rerouteSearchCount: this.rerouteSearchCount,
      reusedRerouteCandidateCount: this.reusedRerouteCandidateCount,
      lastMutationKind: mutation.kind,
      ...(mutation.kind === "swap"
        ? {
            lastMutationPort1Id: mutation.port1Id,
            lastMutationPort2Id: mutation.port2Id,
            lastMutationRegion1Id: mutation.region1Id,
            lastMutationRegion2Id: mutation.region2Id,
          }
        : {
            lastMutationRouteId: mutation.routeId,
            lastMutationCongestionFactor: mutation.congestionFactor,
          }),
    }
  }

  private summarizeCurrentState(): UnravelRegionCostSummary {
    let maxRegionCost = 0
    let totalRegionCost = 0
    let maxRoutingRisk = 0
    let squaredRoutingRisk = 0
    let totalRoutingRisk = 0
    let maxRegionSegmentCount = 0
    let squaredRegionSegmentCount = 0

    for (
      let regionId = 0;
      regionId < this.state.regionIntersectionCaches.length;
      regionId++
    ) {
      const cache = this.state.regionIntersectionCaches[regionId]!
      maxRegionCost = Math.max(maxRegionCost, cache.existingRegionCost)
      totalRegionCost += cache.existingRegionCost
      if (this.REGION_COST_MODEL === "routing-complexity") {
        maxRegionSegmentCount = Math.max(
          maxRegionSegmentCount,
          cache.existingSegmentCount,
        )
        squaredRegionSegmentCount += cache.existingSegmentCount ** 2
      }
      const routingRisk = this.computeExactRoutingRiskForRegion(this, regionId)
      maxRoutingRisk = Math.max(maxRoutingRisk, routingRisk)
      squaredRoutingRisk += routingRisk * routingRisk
      totalRoutingRisk += routingRisk
    }

    return {
      maxRegionCost,
      totalRegionCost,
      maxRegionSegmentCount,
      squaredRegionSegmentCount,
      maxRoutingRisk,
      squaredRoutingRisk,
      totalRoutingRisk,
    }
  }

  private computeRoutingRiskForCounts(
    regionId: RegionId,
    sameLayerIntersections: number,
    transitionPairIntersections: number,
    entryExitLayerChanges: number,
  ): number {
    if (this.REGION_COST_MODEL !== "routing-complexity") return 0

    const metadata = this.topology.regionMetadata?.[regionId]
    if (
      typeof metadata === "object" &&
      metadata !== null &&
      metadata._containsTarget === true
    ) {
      return 0
    }

    return computeRoutingRiskRegionCost(
      this.topology.regionWidth[regionId]!,
      this.topology.regionHeight[regionId]!,
      sameLayerIntersections,
      transitionPairIntersections,
      entryExitLayerChanges,
      this.topology.regionAvailableZMask?.[regionId] ?? 0,
      this.minViaPadDiameter,
    )
  }

  /**
   * Mirrors getIntraNodeCrossingsUsingCircle in the detailed router. In
   * particular, physical chords are grouped by SimpleRouteConnection name,
   * not electrical net or tiny route id, and only the first two distinct
   * points for a connection form its chord in a region.
   */
  private computeExactRoutingRiskForRegion(
    solver: TinyHyperGraphSolver,
    regionId: RegionId,
    options?: {
      removedRouteId?: RouteId
      swap?: { left: BoundaryPortSlot; right: BoundaryPortSlot }
    },
  ): number {
    if (this.REGION_COST_MODEL !== "routing-complexity") return 0

    const pointsByOwner = new Map<number, PortId[]>()
    const addDistinctPoint = (ownerId: number, portId: PortId) => {
      const points = pointsByOwner.get(ownerId) ?? []
      const x = this.topology.portX[portId]
      const y = this.topology.portY[portId]
      const z = this.topology.portZ[portId]
      if (
        !points.some(
          (existingPortId) =>
            this.topology.portX[existingPortId] === x &&
            this.topology.portY[existingPortId] === y &&
            this.topology.portZ[existingPortId] === z,
        )
      ) {
        points.push(portId)
      }
      pointsByOwner.set(ownerId, points)
    }
    const swapPort = (routeId: RouteId, portId: PortId) => {
      const swap = options?.swap
      if (!swap) return portId
      if (swap.left.routeId === routeId && portId === swap.left.portId) {
        return swap.right.portId
      }
      if (swap.right.routeId === routeId && portId === swap.right.portId) {
        return swap.left.portId
      }
      return portId
    }

    for (const [routeId, originalFromPortId, originalToPortId] of solver.state
      .regionSegments[regionId]!) {
      if (routeId === options?.removedRouteId) continue
      const ownerId = this.routingRiskOwnerByRouteId[routeId]!
      addDistinctPoint(ownerId, swapPort(routeId, originalFromPortId))
      addDistinctPoint(ownerId, swapPort(routeId, originalToPortId))
    }

    const lesserAngles: number[] = []
    const greaterAngles: number[] = []
    const layerMasks: number[] = []
    let entryExitLayerChanges = 0
    for (const points of pointsByOwner.values()) {
      if (points.length < 2) continue
      const geometry = this.populateSegmentGeometryScratch(
        regionId,
        points[0]!,
        points[1]!,
      )
      lesserAngles.push(geometry.lesserAngle)
      greaterAngles.push(geometry.greaterAngle)
      layerMasks.push(geometry.layerMask)
      entryExitLayerChanges += geometry.entryExitLayerChanges
    }

    let sameLayerIntersections = 0
    let transitionPairIntersections = 0
    for (let leftIndex = 0; leftIndex < lesserAngles.length; leftIndex++) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < lesserAngles.length;
        rightIndex++
      ) {
        if (
          lesserAngles[leftIndex] === lesserAngles[rightIndex] ||
          lesserAngles[leftIndex] === greaterAngles[rightIndex] ||
          greaterAngles[leftIndex] === lesserAngles[rightIndex] ||
          greaterAngles[leftIndex] === greaterAngles[rightIndex]
        ) {
          continue
        }
        const intersects =
          (lesserAngles[rightIndex]! < lesserAngles[leftIndex]! &&
            lesserAngles[leftIndex]! < greaterAngles[rightIndex]!) !==
          (lesserAngles[rightIndex]! < greaterAngles[leftIndex]! &&
            greaterAngles[leftIndex]! < greaterAngles[rightIndex]!)
        if (!intersects) continue

        const intersectionKind = classifyIntersectionLayerMasks(
          layerMasks[leftIndex]!,
          layerMasks[rightIndex]!,
          "routing-risk",
        )
        if (intersectionKind === "same-layer") {
          sameLayerIntersections += 1
        } else if (intersectionKind === "transition-pair") {
          transitionPairIntersections += 1
        }
      }
    }

    return this.computeRoutingRiskForCounts(
      regionId,
      sameLayerIntersections,
      transitionPairIntersections,
      entryExitLayerChanges,
    )
  }

  private getBoundaryPortGroups(): BoundaryPortSlot[][] {
    const occurrencesByPort = Array.from(
      { length: this.topology.portCount },
      () => [] as PortOccurrence[],
    )

    for (
      let regionId = 0;
      regionId < this.state.regionSegments.length;
      regionId++
    ) {
      for (const [routeId, fromPortId, toPortId] of this.state.regionSegments[
        regionId
      ]!) {
        occurrencesByPort[fromPortId]!.push({ regionId, routeId })
        occurrencesByPort[toPortId]!.push({ regionId, routeId })
      }
    }

    const groupsByBoundary = new Map<string, BoundaryPortSlot[]>()
    for (let portId = 0; portId < occurrencesByPort.length; portId++) {
      if (this.endpointPortMask[portId] === 1) continue

      const occurrences = occurrencesByPort[portId]!
      const incidentRegionIds = this.topology.incidentPortRegion[portId] ?? []
      if (incidentRegionIds.length !== 2) continue
      const region1Id = Math.min(incidentRegionIds[0]!, incidentRegionIds[1]!)
      const region2Id = Math.max(incidentRegionIds[0]!, incidentRegionIds[1]!)

      let routeId: RouteId | undefined
      if (occurrences.length === 0) {
        if (this.state.portAssignment[portId] !== -1) continue
      } else {
        if (occurrences.length !== 2) continue
        routeId = occurrences[0]!.routeId
        if (
          occurrences[1]!.routeId !== routeId ||
          occurrences[0]!.regionId === occurrences[1]!.regionId ||
          !occurrences.some(({ regionId }) => regionId === region1Id) ||
          !occurrences.some(({ regionId }) => regionId === region2Id) ||
          this.state.portAssignment[portId] !== this.problem.routeNet[routeId]
        ) {
          continue
        }
      }

      const boundaryKey = `${region1Id}:${region2Id}`
      const group = groupsByBoundary.get(boundaryKey) ?? []
      group.push({ portId, routeId, region1Id, region2Id })
      groupsByBoundary.set(boundaryKey, group)
    }

    return [...groupsByBoundary.values()]
      .filter(
        (group) =>
          group.length >= 2 &&
          group.some(({ routeId }) => routeId !== undefined),
      )
      .map((group) => group.sort((left, right) => left.portId - right.portId))
  }

  private findBestSwapMutation(): SwapMutation | undefined {
    const routingRiskByRegion = Float64Array.from(
      this.state.regionIntersectionCaches,
      (_, regionId) => this.computeExactRoutingRiskForRegion(this, regionId),
    )
    const squaredRoutingRiskByRegion = Float64Array.from(
      routingRiskByRegion,
      (routingRisk) => routingRisk * routingRisk,
    )
    const rankedRegionIds = Array.from(
      { length: this.topology.regionCount },
      (_, regionId) => regionId,
    ).sort(
      (left, right) =>
        this.state.regionIntersectionCaches[right]!.existingRegionCost -
          this.state.regionIntersectionCaches[left]!.existingRegionCost ||
        left - right,
    )
    const getUnaffectedMaxRegionCost = (
      region1Id: RegionId,
      region2Id: RegionId,
    ) => {
      for (const regionId of rankedRegionIds) {
        if (regionId !== region1Id && regionId !== region2Id) {
          return this.state.regionIntersectionCaches[regionId]!
            .existingRegionCost
        }
      }
      return 0
    }
    const rankedRoutingRiskRegionIds = Array.from(
      { length: this.topology.regionCount },
      (_, regionId) => regionId,
    ).sort(
      (left, right) =>
        routingRiskByRegion[right]! - routingRiskByRegion[left]! ||
        left - right,
    )
    const getUnaffectedMaxRoutingRisk = (
      region1Id: RegionId,
      region2Id: RegionId,
    ) => {
      for (const regionId of rankedRoutingRiskRegionIds) {
        if (regionId !== region1Id && regionId !== region2Id) {
          return routingRiskByRegion[regionId]!
        }
      }
      return 0
    }

    let bestMutation: SwapMutation | undefined
    for (const group of this.getBoundaryPortGroups()) {
      const { region1Id, region2Id } = group[0]!
      const oldRegion1Cost =
        this.state.regionIntersectionCaches[region1Id]!.existingRegionCost
      const oldRegion2Cost =
        this.state.regionIntersectionCaches[region2Id]!.existingRegionCost
      const unaffectedMaxRegionCost = getUnaffectedMaxRegionCost(
        region1Id,
        region2Id,
      )
      const unaffectedMaxRoutingRisk = getUnaffectedMaxRoutingRisk(
        region1Id,
        region2Id,
      )

      for (let leftIndex = 0; leftIndex < group.length; leftIndex++) {
        const left = group[leftIndex]!
        for (
          let rightIndex = leftIndex + 1;
          rightIndex < group.length;
          rightIndex++
        ) {
          const right = group[rightIndex]!
          if (left.routeId === undefined && right.routeId === undefined)
            continue
          if (left.routeId !== undefined && left.routeId === right.routeId) {
            continue
          }
          // A cross-layer untwist may move an existing transition across this
          // boundary, but it must not add or remove transitions for either
          // route. That keeps the mutation local instead of silently changing
          // a long-range layer assignment that this two-region cost cannot see.
          if (
            this.REGION_COST_MODEL === "routing-complexity" &&
            this.topology.portZ[left.portId] !==
              this.topology.portZ[right.portId] &&
            !this.preservesRouteLayerChangeCountsAfterSwap(left, right)
          ) {
            this.rejectedCrossLayerSwapCount += 1
            continue
          }
          this.evaluatedMutationCount += 1

          const region1Metrics = this.computeRegionMetricsAfterSwap(
            region1Id,
            left,
            right,
          )
          const region2Metrics = this.computeRegionMetricsAfterSwap(
            region2Id,
            left,
            right,
          )
          const summary = {
            maxRegionCost: Math.max(
              unaffectedMaxRegionCost,
              region1Metrics.regionCost,
              region2Metrics.regionCost,
            ),
            maxRoutingRisk: Math.max(
              unaffectedMaxRoutingRisk,
              region1Metrics.routingRisk,
              region2Metrics.routingRisk,
            ),
            squaredRoutingRisk:
              this.currentSummary.squaredRoutingRisk -
              squaredRoutingRiskByRegion[region1Id]! -
              squaredRoutingRiskByRegion[region2Id]! +
              region1Metrics.routingRisk ** 2 +
              region2Metrics.routingRisk ** 2,
            totalRoutingRisk:
              this.currentSummary.totalRoutingRisk -
              routingRiskByRegion[region1Id]! -
              routingRiskByRegion[region2Id]! +
              region1Metrics.routingRisk +
              region2Metrics.routingRisk,
            maxRegionSegmentCount: this.currentSummary.maxRegionSegmentCount,
            squaredRegionSegmentCount:
              this.currentSummary.squaredRegionSegmentCount,
            totalRegionCost:
              this.currentSummary.totalRegionCost -
              oldRegion1Cost -
              oldRegion2Cost +
              region1Metrics.regionCost +
              region2Metrics.regionCost,
          }
          if (!isParetoImprovement(summary, this.currentSummary)) {
            continue
          }

          const mutation: SwapMutation = {
            kind: "swap",
            port1Id: left.portId,
            port2Id: right.portId,
            ...(left.routeId === undefined ? {} : { route1Id: left.routeId }),
            ...(right.routeId === undefined ? {} : { route2Id: right.routeId }),
            region1Id,
            region2Id,
            region1Cost: region1Metrics.regionCost,
            region2Cost: region2Metrics.regionCost,
            summary,
          }
          if (
            !bestMutation ||
            compareRegionCostSummaries(summary, bestMutation.summary) < 0 ||
            (compareRegionCostSummaries(summary, bestMutation.summary) === 0 &&
              (mutation.port1Id < bestMutation.port1Id ||
                (mutation.port1Id === bestMutation.port1Id &&
                  mutation.port2Id < bestMutation.port2Id)))
          ) {
            bestMutation = mutation
          }
        }
      }
    }

    return bestMutation
  }

  private preservesRouteLayerChangeCountsAfterSwap(
    left: BoundaryPortSlot,
    right: BoundaryPortSlot,
  ): boolean {
    for (const routeId of [left.routeId, right.routeId]) {
      if (routeId === undefined) continue

      let currentLayerChangeCount = 0
      let swappedLayerChangeCount = 0
      for (const regionId of [left.region1Id, left.region2Id]) {
        for (const [
          segmentRouteId,
          originalFromPortId,
          originalToPortId,
        ] of this.state.regionSegments[regionId]!) {
          if (segmentRouteId !== routeId) continue

          let fromPortId = originalFromPortId
          let toPortId = originalToPortId
          if (left.routeId === routeId) {
            if (fromPortId === left.portId) fromPortId = right.portId
            if (toPortId === left.portId) toPortId = right.portId
          } else if (right.routeId === routeId) {
            if (fromPortId === right.portId) fromPortId = left.portId
            if (toPortId === right.portId) toPortId = left.portId
          }

          if (
            this.topology.portZ[originalFromPortId] !==
            this.topology.portZ[originalToPortId]
          ) {
            currentLayerChangeCount += 1
          }
          if (
            this.topology.portZ[fromPortId] !== this.topology.portZ[toPortId]
          ) {
            swappedLayerChangeCount += 1
          }
        }
      }

      if (currentLayerChangeCount !== swappedLayerChangeCount) return false
    }

    return true
  }

  private findBestRerouteMutation(
    swapIncumbentSummary?: UnravelRegionCostSummary,
  ): RerouteMutation | undefined {
    if (
      this.MAX_HOT_REGIONS === 0 ||
      this.MAX_REROUTE_ROUTES === 0 ||
      this.REROUTE_CONGESTION_FACTORS.length === 0
    ) {
      return
    }

    // Rank every route by the exact objective it could achieve if it vanished,
    // then use that value as an admissible lower bound for branch-and-bound.
    // The old default sampled routes from one or a few high-cost regions and
    // returned the first improvement. That missed globally better reroutes and
    // ignored crowded zero-crossing regions. With uncapped defaults, every
    // routed connection participates in the same deterministic search.
    const candidateRegionIds = Array.from(
      { length: this.topology.regionCount },
      (_, regionId) => regionId,
    )
      .sort(
        (left, right) =>
          this.state.regionIntersectionCaches[right]!.existingRegionCost -
            this.state.regionIntersectionCaches[left]!.existingRegionCost ||
          left - right,
      )
      .slice(0, this.MAX_HOT_REGIONS)
    const routeIds = [
      ...new Set(
        candidateRegionIds.flatMap((regionId) =>
          this.state.regionSegments[regionId]!.map(([routeId]) => routeId),
        ),
      ),
    ]
    const routeCandidates = routeIds
      .map((routeId) => ({
        routeId,
        optimisticSummary: this.summarizeStateWithoutRoute(routeId),
      }))
      .sort(
        (left, right) =>
          compareRegionCostSummaries(
            left.optimisticSummary,
            right.optimisticSummary,
          ) || left.routeId - right.routeId,
      )
      .slice(0, this.MAX_REROUTE_ROUTES)

    const candidateSolver = (this.routeReplacementSolver ??=
      new SingleRouteReplacementSolver(this, this.REROUTE_MAX_ITERATIONS))
    type ScoredRerouteCandidate = {
      mutation?: RerouteMutation
      reusable: boolean
    }
    const scorePreparedCandidate = (
      routeId: RouteId,
      congestionFactor: number,
      replacementPath: ReplacementPathSegment[],
    ): ScoredRerouteCandidate => {
      this.evaluatedMutationCount += 1
      if (!candidateSolver.solved || candidateSolver.failed) {
        return { reusable: false }
      }

      const candidateRouteSegmentCount =
        candidateSolver.replacementRouteSegmentCount
      if (
        candidateRouteSegmentCount >
        this.initialRouteSegmentCounts[routeId]! +
          this.MAX_REROUTE_SEGMENT_INCREASE
      ) {
        this.rejectedRerouteDetourCount += 1
        return { reusable: false }
      }

      // A post-solve optimization may relocate an existing transition, but it
      // must not introduce additional transitions into an already valid route.
      // Extra transitions become extra vias in the detailed router and can
      // create pad/obstacle clearance failures outside the rerouted regions.
      if (
        this.getRouteLayerChangeCount(candidateSolver, routeId) >
        this.getRouteLayerChangeCount(this, routeId)
      ) {
        this.rejectedRerouteLayerChangeCount += 1
        return { reusable: false }
      }

      candidateSolver.rescoreForOptimizer(this)
      const summary = this.summarizeSolverState(candidateSolver)
      if (!isParetoImprovement(summary, this.currentSummary)) {
        return { reusable: true }
      }

      return {
        reusable: true,
        mutation: {
          kind: "reroute",
          routeId,
          congestionFactor,
          replacementPath,
          replacementState: candidateSolver.getReplacementState(),
          summary,
        },
      }
    }
    const evaluateRoute = (
      routeId: RouteId,
      congestionFactor: number,
    ): ScoredRerouteCandidate => {
      candidateSolver.resetForRoute(this, routeId, congestionFactor)
      candidateSolver.solve()
      this.rerouteSearchCount += 1
      this.rerouteSearchIterationCount += candidateSolver.iterations
      if (!candidateSolver.solved || candidateSolver.failed) {
        this.evaluatedMutationCount += 1
        return { reusable: false }
      }
      return scorePreparedCandidate(
        routeId,
        congestionFactor,
        candidateSolver.getReplacementPath(routeId),
      )
    }
    const selectBetterReroute = (
      bestMutation: RerouteMutation | undefined,
      mutation: RerouteMutation | undefined,
    ) => {
      if (!mutation) return bestMutation
      if (!bestMutation) return mutation
      const comparison = compareRegionCostSummaries(
        mutation.summary,
        bestMutation.summary,
      )
      return comparison < 0 ||
        (comparison === 0 &&
          (mutation.routeId < bestMutation.routeId ||
            (mutation.routeId === bestMutation.routeId &&
              mutation.congestionFactor < bestMutation.congestionFactor)))
        ? mutation
        : bestMutation
    }

    const getReroutePathKey = ({
      routeId,
      congestionFactor,
    }: CachedReroutePath) => `${routeId}:${congestionFactor}`
    const retainUnselectedPaths = (
      reusablePaths: Iterable<CachedReroutePath>,
      selectedMutation: RerouteMutation | undefined,
    ) => {
      this.pendingReroutePaths = selectedMutation
        ? [...reusablePaths].filter(
            ({ routeId, congestionFactor }) =>
              routeId !== selectedMutation.routeId ||
              congestionFactor !== selectedMutation.congestionFactor,
          )
        : [...reusablePaths]
    }

    // A full route sweep solves many valid paths but can apply only one.
    // Revalidate those exact paths against the new state before launching A*
    // again. Port ownership validation plus full objective rescoring make reuse
    // exact; when the cache is exhausted, the fresh sweep below still provides
    // the local-optimum proof.
    if (this.pendingReroutePaths.length > 0) {
      const pendingPaths = this.pendingReroutePaths
      this.pendingReroutePaths = []
      const reusablePathByKey = new Map<string, CachedReroutePath>()
      let bestCachedMutation: RerouteMutation | undefined
      for (const cachedPath of pendingPaths) {
        if (
          !candidateSolver.loadReplacementPath(
            this,
            cachedPath.routeId,
            cachedPath.congestionFactor,
            cachedPath.replacementPath,
          )
        ) {
          continue
        }
        this.reusedRerouteCandidateCount += 1
        const scoredCandidate = scorePreparedCandidate(
          cachedPath.routeId,
          cachedPath.congestionFactor,
          cachedPath.replacementPath,
        )
        if (scoredCandidate.reusable) {
          reusablePathByKey.set(getReroutePathKey(cachedPath), cachedPath)
        }
        const mutation = scoredCandidate.mutation
        if (!mutation) continue
        if (
          swapIncumbentSummary &&
          compareRegionCostSummaries(mutation.summary, swapIncumbentSummary) >=
            0
        ) {
          continue
        }
        bestCachedMutation = selectBetterReroute(bestCachedMutation, mutation)
      }
      if (bestCachedMutation) {
        retainUnselectedPaths(reusablePathByKey.values(), bestCachedMutation)
        return bestCachedMutation
      }

      // Preserve valid cached paths through the fresh sweep. A newly searched
      // path for the same route replaces the older snapshot in the map.
      this.pendingReroutePaths = [...reusablePathByKey.values()]
    }

    let bestMutation: RerouteMutation | undefined
    const reusablePathByKey = new Map(
      this.pendingReroutePaths.map((path) => [getReroutePathKey(path), path]),
    )
    this.pendingReroutePaths = []
    for (
      let candidateIndex = 0;
      candidateIndex < routeCandidates.length;
      candidateIndex++
    ) {
      const { routeId, optimisticSummary } = routeCandidates[candidateIndex]!
      if (
        swapIncumbentSummary &&
        compareRegionCostSummaries(optimisticSummary, swapIncumbentSummary) >= 0
      ) {
        this.prunedRerouteSearchCount +=
          (routeCandidates.length - candidateIndex) *
          this.REROUTE_CONGESTION_FACTORS.length
        break
      }
      if (bestMutation) {
        const boundComparison = compareRegionCostSummaries(
          optimisticSummary,
          bestMutation.summary,
        )
        if (
          boundComparison > 0 ||
          (boundComparison === 0 && routeId > bestMutation.routeId)
        ) {
          this.prunedRerouteSearchCount +=
            (routeCandidates.length - candidateIndex) *
            this.REROUTE_CONGESTION_FACTORS.length
          break
        }
      }
      for (const congestionFactor of this.REROUTE_CONGESTION_FACTORS) {
        const scoredCandidate = evaluateRoute(routeId, congestionFactor)
        const mutation = scoredCandidate.mutation
        if (scoredCandidate.reusable) {
          const reusablePath: CachedReroutePath = {
            routeId,
            congestionFactor,
            replacementPath:
              mutation?.replacementPath ??
              candidateSolver.getReplacementPath(routeId),
          }
          reusablePathByKey.set(getReroutePathKey(reusablePath), reusablePath)
        }
        if (!mutation) continue
        if (
          swapIncumbentSummary &&
          compareRegionCostSummaries(mutation.summary, swapIncumbentSummary) >=
            0
        ) {
          continue
        }
        bestMutation = selectBetterReroute(bestMutation, mutation)
      }
    }

    retainUnselectedPaths(reusablePathByKey.values(), bestMutation)
    return bestMutation
  }

  private getRouteSegmentCount(
    solver: TinyHyperGraphSolver,
    routeId: RouteId,
  ): number {
    let segmentCount = 0
    for (const segments of solver.state.regionSegments) {
      for (const [segmentRouteId] of segments) {
        if (segmentRouteId === routeId) segmentCount += 1
      }
    }
    return segmentCount
  }

  private getRouteLayerChangeCount(
    solver: TinyHyperGraphSolver,
    routeId: RouteId,
  ): number {
    let layerChangeCount = 0
    for (const segments of solver.state.regionSegments) {
      for (const [segmentRouteId, fromPortId, toPortId] of segments) {
        if (segmentRouteId !== routeId) continue
        if (
          solver.topology.portZ[fromPortId] !== solver.topology.portZ[toPortId]
        ) {
          layerChangeCount += 1
        }
      }
    }
    return layerChangeCount
  }

  private computeRegionMetricsWithoutRoute(
    regionId: RegionId,
    removedRouteId: RouteId,
  ) {
    const intersectionOwnerIds: number[] = []
    const lesserAngles: number[] = []
    const greaterAngles: number[] = []
    const layerMasks: number[] = []
    const seenIntersectionOwnerIds = new Set<number>()
    let entryExitLayerChanges = 0
    let remainingSegmentCount = 0

    for (const [routeId, fromPortId, toPortId] of this.state.regionSegments[
      regionId
    ]!) {
      if (routeId === removedRouteId) continue
      remainingSegmentCount += 1
      const intersectionOwnerId = this.getIntersectionOwnerId(routeId)
      if (
        this.REGION_COST_MODEL === "routing-risk" &&
        seenIntersectionOwnerIds.has(intersectionOwnerId)
      ) {
        continue
      }
      seenIntersectionOwnerIds.add(intersectionOwnerId)
      const geometry = this.populateSegmentGeometryScratch(
        regionId,
        fromPortId,
        toPortId,
      )
      intersectionOwnerIds.push(intersectionOwnerId)
      lesserAngles.push(geometry.lesserAngle)
      greaterAngles.push(geometry.greaterAngle)
      layerMasks.push(geometry.layerMask)
      entryExitLayerChanges += geometry.entryExitLayerChanges
    }

    let sameLayerIntersections = 0
    let crossingLayerIntersections = 0
    for (
      let leftIndex = 0;
      leftIndex < intersectionOwnerIds.length;
      leftIndex++
    ) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < intersectionOwnerIds.length;
        rightIndex++
      ) {
        if (
          intersectionOwnerIds[leftIndex] === intersectionOwnerIds[rightIndex]
        )
          continue
        if (
          this.REGION_COST_MODEL === "routing-risk" &&
          (lesserAngles[leftIndex] === lesserAngles[rightIndex] ||
            lesserAngles[leftIndex] === greaterAngles[rightIndex] ||
            greaterAngles[leftIndex] === lesserAngles[rightIndex] ||
            greaterAngles[leftIndex] === greaterAngles[rightIndex])
        ) {
          continue
        }
        const intersects =
          (lesserAngles[rightIndex]! < lesserAngles[leftIndex]! &&
            lesserAngles[leftIndex]! < greaterAngles[rightIndex]!) !==
          (lesserAngles[rightIndex]! < greaterAngles[leftIndex]! &&
            greaterAngles[leftIndex]! < greaterAngles[rightIndex]!)
        if (!intersects) continue

        const intersectionKind = classifyIntersectionLayerMasks(
          layerMasks[leftIndex]!,
          layerMasks[rightIndex]!,
          this.REGION_COST_MODEL,
        )
        if (intersectionKind === "same-layer") {
          sameLayerIntersections += 1
        } else if (intersectionKind === "transition-pair") {
          crossingLayerIntersections += 1
        }
      }
    }

    return {
      regionCost: this.computeRegionCostForRegion(
        regionId,
        sameLayerIntersections,
        crossingLayerIntersections,
        entryExitLayerChanges,
        intersectionOwnerIds.length,
      ),
      routingRisk: this.computeExactRoutingRiskForRegion(this, regionId, {
        removedRouteId,
      }),
      segmentCount: remainingSegmentCount,
    }
  }

  private summarizeSolverState(
    solver: TinyHyperGraphSolver,
  ): UnravelRegionCostSummary {
    let maxRegionCost = 0
    let totalRegionCost = 0
    let maxRoutingRisk = 0
    let squaredRoutingRisk = 0
    let totalRoutingRisk = 0
    let maxRegionSegmentCount = 0
    let squaredRegionSegmentCount = 0
    for (
      let regionId = 0;
      regionId < solver.state.regionIntersectionCaches.length;
      regionId++
    ) {
      const cache = solver.state.regionIntersectionCaches[regionId]!
      maxRegionCost = Math.max(maxRegionCost, cache.existingRegionCost)
      totalRegionCost += cache.existingRegionCost
      if (this.REGION_COST_MODEL === "routing-complexity") {
        maxRegionSegmentCount = Math.max(
          maxRegionSegmentCount,
          cache.existingSegmentCount,
        )
        squaredRegionSegmentCount += cache.existingSegmentCount ** 2
      }
      const routingRisk = this.computeExactRoutingRiskForRegion(
        solver,
        regionId,
      )
      maxRoutingRisk = Math.max(maxRoutingRisk, routingRisk)
      squaredRoutingRisk += routingRisk * routingRisk
      totalRoutingRisk += routingRisk
    }
    return {
      maxRegionCost,
      totalRegionCost,
      maxRegionSegmentCount,
      squaredRegionSegmentCount,
      maxRoutingRisk,
      squaredRoutingRisk,
      totalRoutingRisk,
    }
  }

  private summarizeStateWithoutRoute(
    routeId: RouteId,
  ): UnravelRegionCostSummary {
    let maxRegionCost = 0
    let totalRegionCost = 0
    let maxRoutingRisk = 0
    let squaredRoutingRisk = 0
    let totalRoutingRisk = 0
    let maxRegionSegmentCount = 0
    let squaredRegionSegmentCount = 0

    for (let regionId = 0; regionId < this.topology.regionCount; regionId++) {
      const cache = this.state.regionIntersectionCaches[regionId]!
      const regionMetrics = this.state.regionSegments[regionId]!.some(
        ([segmentRouteId]) => segmentRouteId === routeId,
      )
        ? this.computeRegionMetricsWithoutRoute(regionId, routeId)
        : {
            regionCost: cache.existingRegionCost,
            routingRisk: this.computeExactRoutingRiskForRegion(this, regionId),
            segmentCount: cache.existingSegmentCount,
          }
      maxRegionCost = Math.max(maxRegionCost, regionMetrics.regionCost)
      totalRegionCost += regionMetrics.regionCost
      maxRoutingRisk = Math.max(maxRoutingRisk, regionMetrics.routingRisk)
      squaredRoutingRisk += regionMetrics.routingRisk ** 2
      totalRoutingRisk += regionMetrics.routingRisk
      if (this.REGION_COST_MODEL === "routing-complexity") {
        maxRegionSegmentCount = Math.max(
          maxRegionSegmentCount,
          regionMetrics.segmentCount,
        )
        squaredRegionSegmentCount += regionMetrics.segmentCount ** 2
      }
    }

    return {
      maxRegionCost,
      totalRegionCost,
      maxRegionSegmentCount,
      squaredRegionSegmentCount,
      maxRoutingRisk,
      squaredRoutingRisk,
      totalRoutingRisk,
    }
  }

  private computeRegionMetricsAfterSwap(
    regionId: RegionId,
    left: BoundaryPortSlot,
    right: BoundaryPortSlot,
  ) {
    const intersectionOwnerIds: number[] = []
    const lesserAngles: number[] = []
    const greaterAngles: number[] = []
    const layerMasks: number[] = []
    const seenIntersectionOwnerIds = new Set<number>()
    let entryExitLayerChanges = 0

    for (const [routeId, originalFromPortId, originalToPortId] of this.state
      .regionSegments[regionId]!) {
      let fromPortId = originalFromPortId
      let toPortId = originalToPortId
      if (left.routeId !== undefined && routeId === left.routeId) {
        if (fromPortId === left.portId) fromPortId = right.portId
        if (toPortId === left.portId) toPortId = right.portId
      } else if (right.routeId !== undefined && routeId === right.routeId) {
        if (fromPortId === right.portId) fromPortId = left.portId
        if (toPortId === right.portId) toPortId = left.portId
      }

      const geometry = this.populateSegmentGeometryScratch(
        regionId,
        fromPortId,
        toPortId,
      )
      const intersectionOwnerId = this.getIntersectionOwnerId(routeId)
      if (
        this.REGION_COST_MODEL === "routing-risk" &&
        seenIntersectionOwnerIds.has(intersectionOwnerId)
      ) {
        continue
      }
      seenIntersectionOwnerIds.add(intersectionOwnerId)
      intersectionOwnerIds.push(intersectionOwnerId)
      lesserAngles.push(geometry.lesserAngle)
      greaterAngles.push(geometry.greaterAngle)
      layerMasks.push(geometry.layerMask)
      entryExitLayerChanges += geometry.entryExitLayerChanges
    }

    let sameLayerIntersections = 0
    let crossingLayerIntersections = 0
    for (
      let leftIndex = 0;
      leftIndex < intersectionOwnerIds.length;
      leftIndex++
    ) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < intersectionOwnerIds.length;
        rightIndex++
      ) {
        if (
          intersectionOwnerIds[leftIndex] === intersectionOwnerIds[rightIndex]
        )
          continue
        if (
          this.REGION_COST_MODEL === "routing-risk" &&
          (lesserAngles[leftIndex] === lesserAngles[rightIndex] ||
            lesserAngles[leftIndex] === greaterAngles[rightIndex] ||
            greaterAngles[leftIndex] === lesserAngles[rightIndex] ||
            greaterAngles[leftIndex] === greaterAngles[rightIndex])
        ) {
          continue
        }
        const intersects =
          (lesserAngles[rightIndex]! < lesserAngles[leftIndex]! &&
            lesserAngles[leftIndex]! < greaterAngles[rightIndex]!) !==
          (lesserAngles[rightIndex]! < greaterAngles[leftIndex]! &&
            greaterAngles[leftIndex]! < greaterAngles[rightIndex]!)
        if (!intersects) continue

        const intersectionKind = classifyIntersectionLayerMasks(
          layerMasks[leftIndex]!,
          layerMasks[rightIndex]!,
          this.REGION_COST_MODEL,
        )
        if (intersectionKind === "same-layer") {
          sameLayerIntersections += 1
        } else if (intersectionKind === "transition-pair") {
          crossingLayerIntersections += 1
        }
      }
    }

    return {
      regionCost: this.computeRegionCostForRegion(
        regionId,
        sameLayerIntersections,
        crossingLayerIntersections,
        entryExitLayerChanges,
        intersectionOwnerIds.length,
      ),
      routingRisk: this.computeExactRoutingRiskForRegion(this, regionId, {
        swap: { left, right },
      }),
    }
  }

  private applySwapMutation(mutation: SwapMutation) {
    // Cached replacement paths were expressed in the pre-swap boundary-port
    // coordinates. Carry the affected route's paths through the same exact port
    // permutation so they remain candidates after the untwist descent. Every
    // transformed path is still ownership-validated and rescored before use.
    for (const cachedPath of this.pendingReroutePaths) {
      let fromPortId: PortId | undefined
      let toPortId: PortId | undefined
      if (cachedPath.routeId === mutation.route1Id) {
        fromPortId = mutation.port1Id
        toPortId = mutation.port2Id
      } else if (cachedPath.routeId === mutation.route2Id) {
        fromPortId = mutation.port2Id
        toPortId = mutation.port1Id
      }
      if (fromPortId === undefined || toPortId === undefined) continue

      for (const segment of cachedPath.replacementPath) {
        if (segment.fromPortId === fromPortId) segment.fromPortId = toPortId
        if (segment.toPortId === fromPortId) segment.toPortId = toPortId
      }
    }

    for (const regionId of [mutation.region1Id, mutation.region2Id]) {
      for (const segment of this.state.regionSegments[regionId]!) {
        if (
          mutation.route1Id !== undefined &&
          segment[0] === mutation.route1Id
        ) {
          if (segment[1] === mutation.port1Id) {
            segment[1] = mutation.port2Id
          }
          if (segment[2] === mutation.port1Id) {
            segment[2] = mutation.port2Id
          }
        } else if (
          mutation.route2Id !== undefined &&
          segment[0] === mutation.route2Id
        ) {
          if (segment[1] === mutation.port2Id) {
            segment[1] = mutation.port1Id
          }
          if (segment[2] === mutation.port2Id) {
            segment[2] = mutation.port1Id
          }
        }
      }
    }

    this.state.portAssignment[mutation.port1Id] =
      mutation.route2Id === undefined
        ? -1
        : this.problem.routeNet[mutation.route2Id]!
    this.state.portAssignment[mutation.port2Id] =
      mutation.route1Id === undefined
        ? -1
        : this.problem.routeNet[mutation.route1Id]!
    this.rebuildRegionCache(mutation.region1Id)
    this.rebuildRegionCache(mutation.region2Id)
  }

  private applyRerouteMutation(mutation: RerouteMutation) {
    this.state.portAssignment = mutation.replacementState.portAssignment
    this.state.regionSegments = mutation.replacementState.regionSegments
    this.state.regionIntersectionCaches =
      mutation.replacementState.regionIntersectionCaches
    this.state.regionCongestionCost.fill(0)
    this.state.currentRouteId = undefined
    this.state.currentRouteNetId = undefined
    this.state.unroutedRoutes = []
    this.state.candidateQueue.clear()
    this.resetCandidateBestCosts()
    this.state.goalPortId = -1
  }

  private getIntersectionOwnerId(routeId: RouteId): number {
    return this.REGION_COST_MODEL === "routing-risk"
      ? routeId
      : this.problem.routeNet[routeId]!
  }

  private rebuildRegionCache(regionId: RegionId) {
    this.state.regionSegments[regionId]!.sort(
      (left, right) => left[0] - right[0],
    )
    this.state.regionIntersectionCaches[regionId] =
      createEmptyRegionIntersectionCache()
    for (const [routeId, fromPortId, toPortId] of this.state.regionSegments[
      regionId
    ]!) {
      this.state.currentRouteId = routeId
      this.state.currentRouteNetId = this.problem.routeNet[routeId]
      this.appendSegmentToRegionCache(regionId, fromPortId, toPortId)
    }
    this.state.currentRouteId = undefined
    this.state.currentRouteNetId = undefined
  }

  private finishOptimization(
    reason: "local_optimum" | "mutation_limit" | "reroute_limit",
  ) {
    this.stats = {
      ...this.stats,
      finalMaxRegionCost: this.currentSummary.maxRegionCost,
      finalTotalRegionCost: this.currentSummary.totalRegionCost,
      acceptedMutationCount: this.acceptedMutationCount,
      acceptedSwapMutationCount: this.acceptedSwapMutationCount,
      acceptedRerouteMutationCount: this.acceptedRerouteMutationCount,
      evaluatedMutationCount: this.evaluatedMutationCount,
      rejectedRerouteDetourCount: this.rejectedRerouteDetourCount,
      rejectedRerouteLayerChangeCount: this.rejectedRerouteLayerChangeCount,
      rejectedCrossLayerSwapCount: this.rejectedCrossLayerSwapCount,
      prunedRerouteSearchCount: this.prunedRerouteSearchCount,
      rerouteSearchIterationCount: this.rerouteSearchIterationCount,
      rerouteSearchCount: this.rerouteSearchCount,
      reusedRerouteCandidateCount: this.reusedRerouteCandidateCount,
      optimizationStopReason: reason,
      optimized:
        compareRegionCostSummaries(this.currentSummary, this.initialSummary) <
        0,
    }
    this.solved = true
  }

  override tryFinalAcceptance() {
    this.finishOptimization("mutation_limit")
    this.failed = false
    this.error = null
  }
}
