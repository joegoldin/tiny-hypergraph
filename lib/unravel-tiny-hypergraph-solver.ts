import {
  type Candidate,
  createEmptyRegionIntersectionCache,
  getTinyHyperGraphSolverOptions,
  type RegionCostSummary,
  type TinyHyperGraphProblem,
  TinyHyperGraphSolver,
  type TinyHyperGraphSolverOptions,
} from "./core"
import { computeRoutingRiskRegionCostWithPreparedCapacity } from "./computeRegionCost"
import { classifyIntersectionLayerMasks } from "./countNewIntersections"
import type {
  PortId,
  RegionId,
  RegionIntersectionCache,
  RouteId,
} from "./types"

const COST_EPSILON = 1e-9

const getPointToSegmentDistance = (
  pointX: number,
  pointY: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): number => {
  const dx = endX - startX
  const dy = endY - startY
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= COST_EPSILON) {
    return Math.hypot(pointX - startX, pointY - startY)
  }
  const projection = Math.max(
    0,
    Math.min(
      1,
      ((pointX - startX) * dx + (pointY - startY) * dy) / lengthSquared,
    ),
  )
  return Math.hypot(
    pointX - (startX + projection * dx),
    pointY - (startY + projection * dy),
  )
}

interface TerminalKeepout {
  minX: number
  minY: number
  maxX: number
  maxY: number
  z: number
  traceCenterClearance: number
  viaCenterClearance?: number
}

interface IndexedTerminalKeepout extends TerminalKeepout {
  netId: number
}

const getTerminalKeepoutCellKey = (z: number, cellX: number, cellY: number) =>
  `${z}:${cellX}:${cellY}`

const getPointToBoundsDistance = (
  x: number,
  y: number,
  bounds: TerminalKeepout,
): number =>
  Math.hypot(
    Math.max(bounds.minX - x, 0, x - bounds.maxX),
    Math.max(bounds.minY - y, 0, y - bounds.maxY),
  )

const segmentIntersectsBounds = (
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  bounds: TerminalKeepout,
): boolean => {
  let minimumT = 0
  let maximumT = 1
  for (const [start, delta, minimum, maximum] of [
    [startX, endX - startX, bounds.minX, bounds.maxX],
    [startY, endY - startY, bounds.minY, bounds.maxY],
  ] as const) {
    if (Math.abs(delta) <= COST_EPSILON) {
      if (start < minimum || start > maximum) return false
      continue
    }
    const firstT = (minimum - start) / delta
    const secondT = (maximum - start) / delta
    minimumT = Math.max(minimumT, Math.min(firstT, secondT))
    maximumT = Math.min(maximumT, Math.max(firstT, secondT))
    if (minimumT > maximumT) return false
  }
  return true
}

const getSegmentToBoundsDistance = (
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  bounds: TerminalKeepout,
): number => {
  if (segmentIntersectsBounds(startX, startY, endX, endY, bounds)) return 0
  return Math.min(
    getPointToBoundsDistance(startX, startY, bounds),
    getPointToBoundsDistance(endX, endY, bounds),
    ...[
      [bounds.minX, bounds.minY],
      [bounds.minX, bounds.maxY],
      [bounds.maxX, bounds.minY],
      [bounds.maxX, bounds.maxY],
    ].map(([x, y]) =>
      getPointToSegmentDistance(x!, y!, startX, startY, endX, endY),
    ),
  )
}

const getSegmentToTerminalKeepoutClearance = ({
  startX,
  startY,
  startZ,
  endX,
  endY,
  endZ,
  keepout,
}: {
  startX: number
  startY: number
  startZ: number
  endX: number
  endY: number
  endZ: number
  keepout: TerminalKeepout
}): number => {
  const isLayerChange = startZ !== endZ
  if (
    (!isLayerChange && keepout.z !== startZ) ||
    (isLayerChange &&
      (keepout.z < Math.min(startZ, endZ) ||
        keepout.z > Math.max(startZ, endZ)))
  ) {
    return Number.POSITIVE_INFINITY
  }
  return (
    getSegmentToBoundsDistance(startX, startY, endX, endY, keepout) -
    (isLayerChange
      ? (keepout.viaCenterClearance ?? keepout.traceCenterClearance)
      : keepout.traceCenterClearance)
  )
}

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
  /** Total planar length of all region-local route chords. */
  totalSegmentLength: number
  /** Downstream high-density crossing-risk metrics for composite cost plateaus. */
  maxRoutingRisk: number
  squaredRoutingRisk: number
  totalRoutingRisk: number
  /** Worst risk when every routed segment is retained as a physical chord. */
  maxSegmentRoutingRisk: number
}

interface BoundaryPermutation {
  slots: BoundaryPortSlot[]
  destinationPortIds: PortId[]
}

interface BoundaryMutation {
  kind: "swap" | "cycle"
  permutation: BoundaryPermutation
  region1Id: RegionId
  region2Id: RegionId
  region1Cost: number
  region2Cost: number
  region1RoutingRisk: number
  region2RoutingRisk: number
  region1SegmentRoutingRisk: number
  region2SegmentRoutingRisk: number
  region1SegmentLength: number
  region2SegmentLength: number
  summary: UnravelRegionCostSummary
}

interface BoundaryScoringContext {
  squaredRoutingRiskByRegion: Float64Array
  getUnaffectedMaxRegionCost: (
    region1Id: RegionId,
    region2Id: RegionId,
  ) => number
  getUnaffectedMaxRoutingRisk: (
    region1Id: RegionId,
    region2Id: RegionId,
  ) => number
  getUnaffectedMaxSegmentRoutingRisk: (
    region1Id: RegionId,
    region2Id: RegionId,
  ) => number
}

type BoundaryMutationScore = Omit<BoundaryMutation, "kind" | "permutation">

interface RerouteMutation {
  kind: "reroute"
  routeId: RouteId
  routeIds: RouteId[]
  congestionFactor: number
  replacementPath: ReplacementPathSegment[]
  replacementState: {
    portAssignment: Int32Array
    regionSegments: Array<[RouteId, PortId, PortId][]>
    regionIntersectionCaches: RegionIntersectionCache[]
  }
  replacementRouteMetrics: Array<{
    routeId: RouteId
    layerChangeCount: number
    segmentLength: number
    foreignEndpointClearances: Float64Array
  }>
  routingRiskByRegion: Float64Array
  segmentRoutingRiskByRegion: Float64Array
  segmentLengthByRegion: Float64Array
  summary: UnravelRegionCostSummary
}

interface ScoredSolverState {
  summary: UnravelRegionCostSummary
  routingRiskByRegion: Float64Array
  segmentRoutingRiskByRegion: Float64Array
  segmentLengthByRegion: Float64Array
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
  /** Optional iteration cap for each route-replacement search. */
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

  if (
    Math.abs(left.maxSegmentRoutingRisk - right.maxSegmentRoutingRisk) >
    COST_EPSILON
  ) {
    return left.maxSegmentRoutingRisk - right.maxSegmentRoutingRisk
  }

  if (
    Math.abs(left.totalSegmentLength - right.totalSegmentLength) > COST_EPSILON
  ) {
    return left.totalSegmentLength - right.totalSegmentLength
  }

  return 0
}

const isParetoImprovement = (
  candidate: UnravelRegionCostSummary,
  current: UnravelRegionCostSummary,
) => {
  if (!isRoutingRiskNoWorse(candidate, current)) return false

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
    candidate.totalSegmentLength <= current.totalSegmentLength + COST_EPSILON
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

const isRoutingRiskNoWorse = (
  candidate: UnravelRegionCostSummary,
  current: UnravelRegionCostSummary,
) =>
  candidate.maxRoutingRisk <= current.maxRoutingRisk + COST_EPSILON &&
  candidate.squaredRoutingRisk <= current.squaredRoutingRisk + COST_EPSILON &&
  candidate.totalRoutingRisk <= current.totalRoutingRisk + COST_EPSILON &&
  candidate.maxSegmentRoutingRisk <=
    current.maxSegmentRoutingRisk + COST_EPSILON

/**
 * Boundary swaps preserve the set of routes in each region and each route's
 * transition count. Their physical safety is therefore governed by the worst
 * local routing risk and planar span; aggregate risk is allowed to move among
 * regions so a sequence of untwists can escape a false Pareto minimum.
 */
const isSwapParetoImprovement = (
  candidate: UnravelRegionCostSummary,
  current: UnravelRegionCostSummary,
) => {
  if (
    candidate.maxRoutingRisk > current.maxRoutingRisk + COST_EPSILON ||
    candidate.maxSegmentRoutingRisk >
      current.maxSegmentRoutingRisk + COST_EPSILON
  ) {
    return false
  }
  if (candidate.maxRegionCost < current.maxRegionCost - COST_EPSILON) {
    return true
  }
  if (candidate.maxRegionCost > current.maxRegionCost + COST_EPSILON) {
    return false
  }
  if (candidate.totalRegionCost > current.totalRegionCost + COST_EPSILON) {
    return false
  }

  return candidate.totalRegionCost < current.totalRegionCost - COST_EPSILON
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
  readonly replacementRouteSegmentCountByRouteId: Int32Array
  readonly replacementRouteLayerChangeCountByRouteId: Int32Array
  readonly replacementRouteSegmentLengthByRouteId: Float64Array
  readonly blockingRouteIds = new Set<RouteId>()
  private readonly writableRegionMask: Int8Array
  private readonly writableRegionIds: RegionId[] = []
  private readonly replacementPathByRouteId = new Map<
    RouteId,
    ReplacementPathSegment[]
  >()
  private indexedInputRegionSegments?: Array<[RouteId, PortId, PortId][]>
  private readonly inputRegionIdsByRouteId: RegionId[][]

  constructor(
    inputSolver: TinyHyperGraphSolver,
    maxIterations: number,
    private readonly isReplacementSegmentAllowed?: (
      routeId: RouteId,
      fromPortId: PortId,
      toPortId: PortId,
    ) => boolean,
  ) {
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
    this.replacementRouteSegmentCountByRouteId = new Int32Array(
      this.problem.routeCount,
    )
    this.replacementRouteLayerChangeCountByRouteId = new Int32Array(
      this.problem.routeCount,
    )
    this.replacementRouteSegmentLengthByRouteId = new Float64Array(
      this.problem.routeCount,
    )
    this.inputRegionIdsByRouteId = Array.from(
      { length: this.problem.routeCount },
      () => [],
    )
  }

  private indexInputRouteRegions(inputSolver: TinyHyperGraphSolver) {
    if (this.indexedInputRegionSegments === inputSolver.state.regionSegments) {
      return
    }
    for (const regionIds of this.inputRegionIdsByRouteId) regionIds.length = 0
    for (
      let regionId = 0;
      regionId < inputSolver.state.regionSegments.length;
      regionId++
    ) {
      for (const [routeId] of inputSolver.state.regionSegments[regionId]!) {
        const regionIds = this.inputRegionIdsByRouteId[routeId]!
        if (regionIds[regionIds.length - 1] !== regionId) {
          regionIds.push(regionId)
        }
      }
    }
    this.indexedInputRegionSegments = inputSolver.state.regionSegments
  }

  resetForRoute(
    inputSolver: TinyHyperGraphSolver,
    routeIdToReplace: RouteId,
    congestionFactor: number,
  ) {
    this.resetForRoutes(inputSolver, [routeIdToReplace], congestionFactor)
  }

  resetForRoutes(
    inputSolver: TinyHyperGraphSolver,
    routeIdsToReplace: RouteId[],
    congestionFactor: number,
  ) {
    const routeIdSet = new Set(routeIdsToReplace)
    this.indexInputRouteRegions(inputSolver)
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
    this.replacementRouteSegmentCountByRouteId.fill(0)
    this.replacementRouteLayerChangeCountByRouteId.fill(0)
    this.replacementRouteSegmentLengthByRouteId.fill(0)
    this.replacementPathByRouteId.clear()
    this.writableRegionMask.fill(0)
    this.writableRegionIds.length = 0
    this.blockingRouteIds.clear()

    this.state.portAssignment.set(inputSolver.state.portAssignment)
    this.state.regionSegments = inputSolver.state.regionSegments.slice()
    this.state.regionIntersectionCaches =
      inputSolver.state.regionIntersectionCaches.slice()
    const removedPortIds = new Set<PortId>()
    const affectedRegionIds = [
      ...new Set(
        routeIdsToReplace.flatMap(
          (routeId) => this.inputRegionIdsByRouteId[routeId]!,
        ),
      ),
    ].sort((left, right) => left - right)

    for (const regionId of affectedRegionIds) {
      const inputSegments = inputSolver.state.regionSegments[regionId]!
      this.writableRegionMask[regionId] = 1
      this.writableRegionIds.push(regionId)
      this.state.regionSegments[regionId] = inputSegments.filter(
        ([routeId, fromPortId, toPortId]) => {
          if (!routeIdSet.has(routeId)) return true
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
    this.state.unroutedRoutes = [...routeIdsToReplace]
    this.state.candidateQueue.clear()
    this.resetCandidateBestCosts()
    this.state.goalPortId = -1
    if (congestionFactor === 0) {
      this.state.regionCongestionCost.fill(0)
    } else {
      for (let regionId = 0; regionId < this.topology.regionCount; regionId++) {
        this.state.regionCongestionCost[regionId] =
          inputSolver.state.regionIntersectionCaches[regionId]!
            .existingRegionCost * congestionFactor
      }
    }
  }

  override onAllRoutesRouted() {
    this.state.currentRouteId = undefined
    this.state.currentRouteNetId = undefined
    this.solved = true
  }

  override isPortReservedForDifferentNet(portId: PortId): boolean {
    const blocked = super.isPortReservedForDifferentNet(portId)
    if (!blocked) return false
    for (const regionId of this.topology.incidentPortRegion[portId] ?? []) {
      for (const [routeId, fromPortId, toPortId] of this.state.regionSegments[
        regionId
      ]!) {
        if (
          routeId !== this.state.currentRouteId &&
          (fromPortId === portId || toPortId === portId)
        ) {
          this.blockingRouteIds.add(routeId)
        }
      }
    }
    return true
  }

  override computeG(
    currentCandidate: Candidate,
    neighborPortId: PortId,
    maximumCost = Number.POSITIVE_INFINITY,
    knownSegmentDistance?: number,
  ): number {
    if (
      this.state.currentRouteId !== undefined &&
      this.isReplacementSegmentAllowed &&
      !this.isReplacementSegmentAllowed(
        this.state.currentRouteId,
        currentCandidate.portId,
        neighborPortId,
      )
    ) {
      return Number.POSITIVE_INFINITY
    }
    return super.computeG(
      currentCandidate,
      neighborPortId,
      maximumCost,
      knownSegmentDistance,
    )
  }

  override onPathFound(
    finalCandidate: Parameters<TinyHyperGraphSolver["onPathFound"]>[0],
  ) {
    const solvedSegments = this.getSolvedPathSegments(finalCandidate)
    if (
      this.state.currentRouteId !== undefined &&
      this.isReplacementSegmentAllowed &&
      solvedSegments.some(
        ({ fromPortId, toPortId }) =>
          !this.isReplacementSegmentAllowed!(
            this.state.currentRouteId!,
            fromPortId,
            toPortId,
          ),
      )
    ) {
      return
    }
    this.replacementRouteSegmentCount = solvedSegments.length
    this.replacementRouteSegmentCountByRouteId[this.state.currentRouteId!] =
      solvedSegments.length
    let replacementRouteLayerChangeCount = 0
    let replacementRouteSegmentLength = 0
    for (const { fromPortId, toPortId } of solvedSegments) {
      if (this.topology.portZ[fromPortId] !== this.topology.portZ[toPortId]) {
        replacementRouteLayerChangeCount += 1
      }
      replacementRouteSegmentLength += Math.hypot(
        this.topology.portX[toPortId]! - this.topology.portX[fromPortId]!,
        this.topology.portY[toPortId]! - this.topology.portY[fromPortId]!,
      )
    }
    this.replacementRouteLayerChangeCountByRouteId[this.state.currentRouteId!] =
      replacementRouteLayerChangeCount
    this.replacementRouteSegmentLengthByRouteId[this.state.currentRouteId!] =
      replacementRouteSegmentLength
    this.replacementPathByRouteId.set(
      this.state.currentRouteId!,
      solvedSegments.map(({ regionId, fromPortId, toPortId }) => ({
        regionId,
        fromPortId,
        toPortId,
      })),
    )
    const touchedRegionIds = new Set<RegionId>()
    for (const { regionId } of solvedSegments) {
      touchedRegionIds.add(regionId)
      if (this.writableRegionMask[regionId] === 0) {
        this.state.regionSegments[regionId] = [
          ...this.state.regionSegments[regionId]!,
        ]
        this.writableRegionMask[regionId] = 1
        this.writableRegionIds.push(regionId)
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
    return [...(this.replacementPathByRouteId.get(routeId) ?? [])]
  }

  loadReplacementPath(
    inputSolver: TinyHyperGraphSolver,
    routeId: RouteId,
    congestionFactor: number,
    path: ReplacementPathSegment[],
  ): boolean {
    return this.loadReplacementPaths(
      inputSolver,
      [{ routeId, path }],
      congestionFactor,
    )
  }

  loadReplacementPaths(
    inputSolver: TinyHyperGraphSolver,
    replacements: Array<{
      routeId: RouteId
      path: ReplacementPathSegment[]
    }>,
    congestionFactor: number,
  ): boolean {
    this.resetForRoutes(
      inputSolver,
      replacements.map(({ routeId }) => routeId),
      congestionFactor,
    )

    for (const { routeId, path } of replacements) {
      const routeNetId = this.problem.routeNet[routeId]!
      this.state.currentRouteId = routeId
      this.state.currentRouteNetId = routeNetId
      const touchedRegionIds = new Set<RegionId>()

      for (const { regionId, fromPortId, toPortId } of path) {
        if (
          this.isReplacementSegmentAllowed &&
          !this.isReplacementSegmentAllowed(routeId, fromPortId, toPortId)
        ) {
          return false
        }
        if (this.isRegionReservedForDifferentNet(regionId)) return false
        for (const portId of [fromPortId, toPortId]) {
          const assignedNetId = this.state.portAssignment[portId]!
          if (assignedNetId !== -1 && assignedNetId !== routeNetId) {
            return false
          }
        }

        if (this.writableRegionMask[regionId] === 0) {
          this.state.regionSegments[regionId] = [
            ...this.state.regionSegments[regionId]!,
          ]
          this.writableRegionMask[regionId] = 1
          this.writableRegionIds.push(regionId)
        }
        this.state.regionSegments[regionId]!.push([
          routeId,
          fromPortId,
          toPortId,
        ])
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
      this.replacementPathByRouteId.set(routeId, [...path])
      this.replacementRouteSegmentCountByRouteId[routeId] = path.length
      let layerChangeCount = 0
      let segmentLength = 0
      for (const { fromPortId, toPortId } of path) {
        if (this.topology.portZ[fromPortId] !== this.topology.portZ[toPortId]) {
          layerChangeCount += 1
        }
        segmentLength += Math.hypot(
          this.topology.portX[toPortId]! - this.topology.portX[fromPortId]!,
          this.topology.portY[toPortId]! - this.topology.portY[fromPortId]!,
        )
      }
      this.replacementRouteLayerChangeCountByRouteId[routeId] = layerChangeCount
      this.replacementRouteSegmentLengthByRouteId[routeId] = segmentLength
      this.replacementRouteSegmentCount += path.length
    }

    this.state.currentRouteId = undefined
    this.state.currentRouteNetId = undefined
    this.solved = true
    return true
  }

  rescoreForOptimizer(inputSolver: TinyHyperGraphSolver) {
    this.TRACE_DENSITY_COST_FACTOR = inputSolver.TRACE_DENSITY_COST_FACTOR
    this.REGION_COST_MODEL = inputSolver.REGION_COST_MODEL
    for (const regionId of this.writableRegionIds) {
      this.rebuildRegionCache(regionId)
    }
  }

  getChangedRegionIds(): readonly RegionId[] {
    return this.writableRegionIds
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
 * Improves a solved hypergraph with alternating atomic boundary permutations,
 * graph-wide route replacements, and dependency-guided two-route ejection
 * chains. Boundary mutations change both sides together, and replacement
 * candidates retain every route outside their exact ejection set. Peak-cost
 * reductions are accepted only when downstream routing risk does not worsen;
 * moves on a peak plateau must improve the remaining physical objectives
 * without worsening any of them.
 */
export class UnravelTinyHyperGraphSolver extends TinyHyperGraphSolver {
  MAX_MUTATIONS = Number.POSITIVE_INFINITY
  MAX_REROUTE_MUTATIONS = Number.POSITIVE_INFINITY
  MAX_HOT_REGIONS = Number.POSITIVE_INFINITY
  REROUTE_MAX_ITERATIONS = Number.POSITIVE_INFINITY
  MAX_REROUTE_ROUTES = Number.POSITIVE_INFINITY
  // The core path cost already includes the exact marginal region cost.
  // Search that deterministic objective once; physical-risk invariants are
  // enforced when the completed replacement is scored.
  REROUTE_CONGESTION_FACTORS = [0]
  MAX_REROUTE_SEGMENT_INCREASE = Number.POSITIVE_INFINITY

  readonly inputSolver: TinyHyperGraphSolver
  initialSummary: UnravelRegionCostSummary
  currentSummary: UnravelRegionCostSummary
  acceptedMutationCount = 0
  acceptedSwapMutationCount = 0
  acceptedCycleMutationCount = 0
  acceptedRerouteMutationCount = 0
  acceptedPairRerouteMutationCount = 0
  evaluatedMutationCount = 0
  rejectedRerouteDetourCount = 0
  rejectedRerouteLayerChangeCount = 0
  rejectedReroutePhysicalRiskCount = 0
  rejectedRerouteEndpointKeepoutCount = 0
  prunedRerouteEndpointKeepoutSegmentCount = 0
  rejectedBoundaryEndpointKeepoutCount = 0
  terminalKeepoutBroadPhaseQueryCount = 0
  terminalKeepoutBroadPhaseCandidateCount = 0
  terminalKeepoutExactCheckCount = 0
  rejectedCrossLayerSwapCount = 0
  prunedRerouteSearchCount = 0
  rerouteSearchIterationCount = 0
  rerouteSearchCount = 0
  reusedRerouteCandidateCount = 0

  private readonly endpointPortMask: Int8Array
  private readonly initialRouteSegmentCounts: Int32Array
  private readonly routeLayerChangeCountByRouteId: Int32Array
  private readonly routeSegmentLengthByRouteId: Float64Array
  private readonly terminalKeepouts: IndexedTerminalKeepout[]
  private readonly terminalKeepoutCellSize: number
  private readonly terminalKeepoutIndexesByCell: Map<string, number[]>
  private readonly hasForeignEndpointKeepouts: boolean
  private readonly routeForeignEndpointClearancesByRouteId: Float64Array[]
  private readonly routingRiskOwnerByRouteId: Int32Array
  private readonly physicalPointIdByPortId: Int32Array
  private routingRiskByRegion: Float64Array
  private segmentRoutingRiskByRegion: Float64Array
  private segmentLengthByRegion: Float64Array
  private routeReplacementSolver?: SingleRouteReplacementSolver
  private pendingReroutePaths: CachedReroutePath[] = []
  private readonly rerouteDependencyRouteIdsByRouteId = new Map<
    RouteId,
    RouteId[]
  >()
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
    this.routeLayerChangeCountByRouteId = new Int32Array(
      this.problem.routeCount,
    )
    this.routeSegmentLengthByRouteId = new Float64Array(this.problem.routeCount)
    this.routingRiskOwnerByRouteId = new Int32Array(this.problem.routeCount)
    this.physicalPointIdByPortId = new Int32Array(this.topology.portCount)
    const physicalPointIdByKey = new Map<string, number>()
    for (let portId = 0; portId < this.topology.portCount; portId++) {
      const key = `${this.topology.portX[portId]},${this.topology.portY[portId]},${this.topology.portZ[portId]}`
      let physicalPointId = physicalPointIdByKey.get(key)
      if (physicalPointId === undefined) {
        physicalPointId = physicalPointIdByKey.size
        physicalPointIdByKey.set(key, physicalPointId)
      }
      this.physicalPointIdByPortId[portId] = physicalPointId
    }
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
    }
    const getTerminalKeepouts = (portId: PortId): TerminalKeepout[] => {
      const metadata = this.topology.portMetadata?.[portId] as
        | { _tinyTerminalKeepouts?: unknown }
        | undefined
      if (!Array.isArray(metadata?._tinyTerminalKeepouts)) return []
      return metadata._tinyTerminalKeepouts.filter(
        (candidate): candidate is TerminalKeepout =>
          typeof candidate === "object" &&
          candidate !== null &&
          ["minX", "minY", "maxX", "maxY", "z", "traceCenterClearance"].every(
            (key) =>
              Number.isFinite(
                (candidate as Record<string, unknown>)[key] as number,
              ),
          ) &&
          ((candidate as Record<string, unknown>).viaCenterClearance ===
            undefined ||
            Number.isFinite(
              (candidate as Record<string, unknown>)
                .viaCenterClearance as number,
            )) &&
          (candidate as TerminalKeepout).minX <=
            (candidate as TerminalKeepout).maxX &&
          (candidate as TerminalKeepout).minY <=
            (candidate as TerminalKeepout).maxY &&
          (candidate as TerminalKeepout).traceCenterClearance >= 0 &&
          ((candidate as TerminalKeepout).viaCenterClearance ?? 0) >= 0,
      )
    }
    const terminalKeepoutByKey = new Map<string, IndexedTerminalKeepout>()
    for (let routeId = 0; routeId < this.problem.routeCount; routeId++) {
      const netId = this.problem.routeNet[routeId]!
      for (const portId of [
        this.problem.routeStartPort[routeId]!,
        this.problem.routeEndPort[routeId]!,
      ]) {
        for (const keepout of getTerminalKeepouts(portId)) {
          const key = [
            netId,
            keepout.minX,
            keepout.minY,
            keepout.maxX,
            keepout.maxY,
            keepout.z,
            keepout.traceCenterClearance,
            keepout.viaCenterClearance ?? keepout.traceCenterClearance,
          ].join(":")
          if (!terminalKeepoutByKey.has(key)) {
            terminalKeepoutByKey.set(key, { ...keepout, netId })
          }
        }
      }
    }
    this.terminalKeepouts = [...terminalKeepoutByKey.values()]
    this.hasForeignEndpointKeepouts =
      this.terminalKeepouts.length > 0 &&
      new Set(this.problem.routeNet).size > 1
    // Index each keepout by its fully inflated physical envelope. The cell
    // size is derived from the largest envelope, so this broad phase has no
    // board- or sample-specific tuning parameter and never excludes an exact
    // geometry candidate.
    this.terminalKeepoutCellSize = this.hasForeignEndpointKeepouts
      ? Math.max(
          ...this.terminalKeepouts.map((keepout) => {
            const expansion = Math.max(
              keepout.traceCenterClearance,
              keepout.viaCenterClearance ?? keepout.traceCenterClearance,
            )
            return Math.max(
              keepout.maxX - keepout.minX + expansion * 2,
              keepout.maxY - keepout.minY + expansion * 2,
            )
          }),
          COST_EPSILON,
        )
      : 1
    this.terminalKeepoutIndexesByCell = new Map()
    for (
      let keepoutIndex = 0;
      keepoutIndex < this.terminalKeepouts.length;
      keepoutIndex++
    ) {
      const keepout = this.terminalKeepouts[keepoutIndex]!
      const expansion = Math.max(
        keepout.traceCenterClearance,
        keepout.viaCenterClearance ?? keepout.traceCenterClearance,
      )
      const minCellX = Math.floor(
        (keepout.minX - expansion) / this.terminalKeepoutCellSize,
      )
      const maxCellX = Math.floor(
        (keepout.maxX + expansion) / this.terminalKeepoutCellSize,
      )
      const minCellY = Math.floor(
        (keepout.minY - expansion) / this.terminalKeepoutCellSize,
      )
      const maxCellY = Math.floor(
        (keepout.maxY + expansion) / this.terminalKeepoutCellSize,
      )
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
          const cellKey = getTerminalKeepoutCellKey(keepout.z, cellX, cellY)
          const indexes = this.terminalKeepoutIndexesByCell.get(cellKey) ?? []
          indexes.push(keepoutIndex)
          this.terminalKeepoutIndexesByCell.set(cellKey, indexes)
        }
      }
    }
    this.routeForeignEndpointClearancesByRouteId = Array.from(
      { length: this.problem.routeCount },
      () => new Float64Array(this.terminalKeepouts.length),
    )
    for (const segments of this.state.regionSegments) {
      for (const [routeId, fromPortId, toPortId] of segments) {
        this.initialRouteSegmentCounts[routeId] += 1
        if (this.topology.portZ[fromPortId] !== this.topology.portZ[toPortId]) {
          this.routeLayerChangeCountByRouteId[routeId] += 1
        }
        this.routeSegmentLengthByRouteId[routeId] += this.computeSegmentLength(
          this,
          fromPortId,
          toPortId,
        )
      }
    }
    for (let routeId = 0; routeId < this.problem.routeCount; routeId++) {
      this.routeForeignEndpointClearancesByRouteId[routeId] =
        this.computeRouteForeignEndpointClearances(this, routeId)
    }

    const initialScoredState = this.summarizeSolverState(this)
    this.routingRiskByRegion = initialScoredState.routingRiskByRegion
    this.segmentRoutingRiskByRegion =
      initialScoredState.segmentRoutingRiskByRegion
    this.segmentLengthByRegion = initialScoredState.segmentLengthByRegion
    this.initialSummary = initialScoredState.summary
    this.currentSummary = { ...this.initialSummary }
  }

  override _setup() {
    this.stats = {
      ...this.stats,
      initialMaxRegionCost: this.initialSummary.maxRegionCost,
      initialTotalRegionCost: this.initialSummary.totalRegionCost,
      initialTotalSegmentLength: this.initialSummary.totalSegmentLength,
      initialMinForeignEndpointClearance:
        this.getMinimumForeignEndpointClearance(),
      finalMaxRegionCost: this.currentSummary.maxRegionCost,
      finalTotalRegionCost: this.currentSummary.totalRegionCost,
      finalTotalSegmentLength: this.currentSummary.totalSegmentLength,
      finalMinForeignEndpointClearance:
        this.getMinimumForeignEndpointClearance(),
      acceptedMutationCount: 0,
      acceptedSwapMutationCount: 0,
      acceptedCycleMutationCount: 0,
      acceptedRerouteMutationCount: 0,
      acceptedPairRerouteMutationCount: 0,
      evaluatedMutationCount: 0,
      rejectedRerouteDetourCount: 0,
      rejectedRerouteLayerChangeCount: 0,
      rejectedReroutePhysicalRiskCount: 0,
      rejectedRerouteEndpointKeepoutCount: 0,
      prunedRerouteEndpointKeepoutSegmentCount: 0,
      rejectedBoundaryEndpointKeepoutCount: 0,
      terminalKeepoutCount: this.terminalKeepouts.length,
      terminalKeepoutCellSize: this.terminalKeepoutCellSize,
      terminalKeepoutBroadPhaseQueryCount:
        this.terminalKeepoutBroadPhaseQueryCount,
      terminalKeepoutBroadPhaseCandidateCount:
        this.terminalKeepoutBroadPhaseCandidateCount,
      terminalKeepoutExactCheckCount: this.terminalKeepoutExactCheckCount,
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
    let mutation: BoundaryMutation | RerouteMutation | undefined
    while (!mutation) {
      if (this.optimizationPhase === "initial_untwist") {
        mutation = this.findBestSwapMutation() ?? this.findBestCycleMutation()
        if (!mutation) this.optimizationPhase = "reroute"
        continue
      }

      if (this.optimizationPhase === "reroute") {
        if (this.acceptedRerouteMutationCount >= this.MAX_REROUTE_MUTATIONS) {
          this.reachedRerouteLimit = true
          this.optimizationPhase = "final_untwist"
          continue
        }
        mutation =
          this.findBestRerouteMutation() ?? this.findBestPairRerouteMutation()
        if (!mutation) this.optimizationPhase = "final_untwist"
        continue
      }

      mutation = this.findBestSwapMutation() ?? this.findBestCycleMutation()
      if (!mutation) {
        this.finishOptimization(
          this.reachedRerouteLimit ? "reroute_limit" : "local_optimum",
        )
        return
      }
    }

    if (mutation.kind === "reroute") {
      this.applyRerouteMutation(mutation)
      this.acceptedRerouteMutationCount += 1
      if (mutation.routeIds.length === 2) {
        this.acceptedPairRerouteMutationCount += 1
      }
      this.optimizationPhase = "initial_untwist"
    } else {
      this.applyBoundaryMutation(mutation)
      if (mutation.kind === "swap") {
        this.acceptedSwapMutationCount += 1
      } else {
        this.acceptedCycleMutationCount += 1
        this.optimizationPhase = "initial_untwist"
      }
    }
    this.acceptedMutationCount += 1
    this.currentSummary = mutation.summary
    this.stats = {
      ...this.stats,
      finalMaxRegionCost: this.currentSummary.maxRegionCost,
      finalTotalRegionCost: this.currentSummary.totalRegionCost,
      finalTotalSegmentLength: this.currentSummary.totalSegmentLength,
      finalMinForeignEndpointClearance:
        this.getMinimumForeignEndpointClearance(),
      acceptedMutationCount: this.acceptedMutationCount,
      acceptedSwapMutationCount: this.acceptedSwapMutationCount,
      acceptedCycleMutationCount: this.acceptedCycleMutationCount,
      acceptedRerouteMutationCount: this.acceptedRerouteMutationCount,
      acceptedPairRerouteMutationCount: this.acceptedPairRerouteMutationCount,
      evaluatedMutationCount: this.evaluatedMutationCount,
      rejectedRerouteDetourCount: this.rejectedRerouteDetourCount,
      rejectedRerouteLayerChangeCount: this.rejectedRerouteLayerChangeCount,
      rejectedReroutePhysicalRiskCount: this.rejectedReroutePhysicalRiskCount,
      rejectedRerouteEndpointKeepoutCount:
        this.rejectedRerouteEndpointKeepoutCount,
      prunedRerouteEndpointKeepoutSegmentCount:
        this.prunedRerouteEndpointKeepoutSegmentCount,
      rejectedBoundaryEndpointKeepoutCount:
        this.rejectedBoundaryEndpointKeepoutCount,
      terminalKeepoutCount: this.terminalKeepouts.length,
      terminalKeepoutCellSize: this.terminalKeepoutCellSize,
      terminalKeepoutBroadPhaseQueryCount:
        this.terminalKeepoutBroadPhaseQueryCount,
      terminalKeepoutBroadPhaseCandidateCount:
        this.terminalKeepoutBroadPhaseCandidateCount,
      terminalKeepoutExactCheckCount: this.terminalKeepoutExactCheckCount,
      rejectedCrossLayerSwapCount: this.rejectedCrossLayerSwapCount,
      prunedRerouteSearchCount: this.prunedRerouteSearchCount,
      rerouteSearchIterationCount: this.rerouteSearchIterationCount,
      rerouteSearchCount: this.rerouteSearchCount,
      reusedRerouteCandidateCount: this.reusedRerouteCandidateCount,
      lastMutationKind: mutation.kind,
      ...(mutation.kind === "reroute"
        ? {
            lastMutationRouteId: mutation.routeId,
            lastMutationRouteIds: mutation.routeIds,
            lastMutationCongestionFactor: mutation.congestionFactor,
          }
        : {
            lastMutationPort1Id: mutation.permutation.slots[0]!.portId,
            lastMutationPort2Id: mutation.permutation.slots[1]!.portId,
            lastMutationRegion1Id: mutation.region1Id,
            lastMutationRegion2Id: mutation.region2Id,
          }),
    }
  }

  private computeRoutingRiskForCounts(
    regionId: RegionId,
    sameLayerIntersections: number,
    transitionPairIntersections: number,
    entryExitLayerChanges: number,
    traceCount: number,
  ) {
    const metadata = this.topology.regionMetadata?.[regionId]
    if (
      typeof metadata === "object" &&
      metadata !== null &&
      metadata._containsTarget === true
    ) {
      return 0
    }

    return computeRoutingRiskRegionCostWithPreparedCapacity(
      this.routingRiskCapacityByRegion[regionId]!,
      sameLayerIntersections,
      transitionPairIntersections,
      entryExitLayerChanges,
      traceCount,
    )
  }

  private remapPortForBoundaryPermutation(
    routeId: RouteId,
    portId: PortId,
    permutation?: BoundaryPermutation,
  ): PortId {
    if (!permutation) return portId
    for (let index = 0; index < permutation.slots.length; index++) {
      const source = permutation.slots[index]!
      if (source.routeId === routeId && source.portId === portId) {
        return permutation.destinationPortIds[index]!
      }
    }
    return portId
  }

  /**
   * Mirrors getIntraNodeCrossingsUsingCircle in the detailed router. In
   * particular, physical chords are grouped by SimpleRouteConnection name,
   * not electrical net or tiny route id, and only the first two distinct
   * points for a connection form its chord in a region.
   */
  private computePhysicalRoutingRisksForRegion(
    solver: TinyHyperGraphSolver,
    regionId: RegionId,
    options?: {
      removedRouteId?: RouteId
      removedRouteIds?: ReadonlySet<RouteId>
      permutation?: BoundaryPermutation
    },
  ) {
    const pointsByOwner = new Map<number, PortId[]>()
    const segments: Array<{
      routeId: RouteId
      fromPortId: PortId
      toPortId: PortId
      lesserAngle: number
      greaterAngle: number
      layerMask: number
    }> = []
    let segmentEntryExitLayerChanges = 0
    const addDistinctPoint = (ownerId: number, portId: PortId) => {
      const points = pointsByOwner.get(ownerId) ?? []
      if (
        !points.some(
          (existingPortId) =>
            this.physicalPointIdByPortId[existingPortId] ===
            this.physicalPointIdByPortId[portId],
        )
      ) {
        points.push(portId)
      }
      pointsByOwner.set(ownerId, points)
    }
    for (const [routeId, originalFromPortId, originalToPortId] of solver.state
      .regionSegments[regionId]!) {
      if (
        routeId === options?.removedRouteId ||
        options?.removedRouteIds?.has(routeId)
      ) {
        continue
      }
      const ownerId = this.routingRiskOwnerByRouteId[routeId]!
      const fromPortId = this.remapPortForBoundaryPermutation(
        routeId,
        originalFromPortId,
        options?.permutation,
      )
      const toPortId = this.remapPortForBoundaryPermutation(
        routeId,
        originalToPortId,
        options?.permutation,
      )
      addDistinctPoint(ownerId, fromPortId)
      addDistinctPoint(ownerId, toPortId)
      const geometry = this.populateSegmentGeometryScratch(
        regionId,
        fromPortId,
        toPortId,
      )
      segments.push({
        routeId,
        fromPortId,
        toPortId,
        lesserAngle: geometry.lesserAngle,
        greaterAngle: geometry.greaterAngle,
        layerMask: geometry.layerMask,
      })
      segmentEntryExitLayerChanges += geometry.entryExitLayerChanges
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

    const groupedRisk = this.computeRoutingRiskForCounts(
      regionId,
      sameLayerIntersections,
      transitionPairIntersections,
      entryExitLayerChanges,
      pointsByOwner.size,
    )

    let segmentSameLayerIntersections = 0
    let segmentTransitionPairIntersections = 0
    for (let leftIndex = 0; leftIndex < segments.length; leftIndex++) {
      const left = segments[leftIndex]!
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < segments.length;
        rightIndex++
      ) {
        const right = segments[rightIndex]!
        if (left.routeId === right.routeId) continue
        const leftFromPointId = this.physicalPointIdByPortId[left.fromPortId]!
        const leftToPointId = this.physicalPointIdByPortId[left.toPortId]!
        const rightFromPointId = this.physicalPointIdByPortId[right.fromPortId]!
        const rightToPointId = this.physicalPointIdByPortId[right.toPortId]!
        if (
          leftFromPointId === rightFromPointId ||
          leftFromPointId === rightToPointId ||
          leftToPointId === rightFromPointId ||
          leftToPointId === rightToPointId
        ) {
          continue
        }
        const intersects =
          (right.lesserAngle < left.lesserAngle &&
            left.lesserAngle < right.greaterAngle) !==
          (right.lesserAngle < left.greaterAngle &&
            left.greaterAngle < right.greaterAngle)
        if (!intersects) continue
        const intersectionKind = classifyIntersectionLayerMasks(
          left.layerMask,
          right.layerMask,
          "routing-complexity",
        )
        if (intersectionKind === "same-layer") {
          segmentSameLayerIntersections += 1
        } else if (intersectionKind === "transition-pair") {
          segmentTransitionPairIntersections += 1
        }
      }
    }

    return {
      groupedRisk,
      segmentRisk: this.computeRoutingRiskForCounts(
        regionId,
        segmentSameLayerIntersections,
        segmentTransitionPairIntersections,
        segmentEntryExitLayerChanges,
        segments.length,
      ),
    }
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

  private createBoundaryScoringContext(): BoundaryScoringContext {
    const routingRiskByRegion = this.routingRiskByRegion
    const segmentRoutingRiskByRegion = this.segmentRoutingRiskByRegion
    const rankRegionIds = (values: ArrayLike<number>) =>
      Array.from(
        { length: this.topology.regionCount },
        (_, regionId) => regionId,
      ).sort((left, right) => values[right]! - values[left]! || left - right)
    const getUnaffectedMax = (
      rankedRegionIds: RegionId[],
      values: ArrayLike<number>,
      region1Id: RegionId,
      region2Id: RegionId,
    ) => {
      for (const regionId of rankedRegionIds) {
        if (regionId !== region1Id && regionId !== region2Id) {
          return values[regionId]!
        }
      }
      return 0
    }
    const regionCosts = Float64Array.from(
      this.state.regionIntersectionCaches,
      (cache) => cache.existingRegionCost,
    )
    const rankedRegionIds = rankRegionIds(regionCosts)
    const rankedRoutingRiskRegionIds = rankRegionIds(routingRiskByRegion)
    const rankedSegmentRoutingRiskRegionIds = rankRegionIds(
      segmentRoutingRiskByRegion,
    )

    return {
      squaredRoutingRiskByRegion: Float64Array.from(
        routingRiskByRegion,
        (routingRisk) => routingRisk * routingRisk,
      ),
      getUnaffectedMaxRegionCost: (region1Id, region2Id) =>
        getUnaffectedMax(rankedRegionIds, regionCosts, region1Id, region2Id),
      getUnaffectedMaxRoutingRisk: (region1Id, region2Id) =>
        getUnaffectedMax(
          rankedRoutingRiskRegionIds,
          routingRiskByRegion,
          region1Id,
          region2Id,
        ),
      getUnaffectedMaxSegmentRoutingRisk: (region1Id, region2Id) =>
        getUnaffectedMax(
          rankedSegmentRoutingRiskRegionIds,
          segmentRoutingRiskByRegion,
          region1Id,
          region2Id,
        ),
    }
  }

  private scoreBoundaryPermutation(
    permutation: BoundaryPermutation,
    context: BoundaryScoringContext,
  ): BoundaryMutationScore | undefined {
    const { region1Id, region2Id } = permutation.slots[0]!
    const crossesLayer = permutation.slots.some(
      (source, index) =>
        this.topology.portZ[source.portId] !==
        this.topology.portZ[permutation.destinationPortIds[index]!],
    )
    if (
      this.REGION_COST_MODEL === "routing-complexity" &&
      crossesLayer &&
      !this.preservesRouteLayerChangeCountsAfterPermutation(permutation)
    ) {
      this.rejectedCrossLayerSwapCount += 1
      return
    }
    this.evaluatedMutationCount += 1

    const oldRegion1Cost =
      this.state.regionIntersectionCaches[region1Id]!.existingRegionCost
    const oldRegion2Cost =
      this.state.regionIntersectionCaches[region2Id]!.existingRegionCost
    const region1PrimaryMetrics =
      this.computePrimaryRegionMetricsAfterPermutation(region1Id, permutation)
    const region2PrimaryMetrics =
      this.computePrimaryRegionMetricsAfterPermutation(region2Id, permutation)
    const candidateMaxRegionCost = Math.max(
      context.getUnaffectedMaxRegionCost(region1Id, region2Id),
      region1PrimaryMetrics.regionCost,
      region2PrimaryMetrics.regionCost,
    )
    const candidateTotalRegionCost =
      this.currentSummary.totalRegionCost -
      oldRegion1Cost -
      oldRegion2Cost +
      region1PrimaryMetrics.regionCost +
      region2PrimaryMetrics.regionCost

    // Physical-risk scoring is the expensive part of a boundary evaluation.
    // The primary objective is independent of those metrics, so this exact
    // bound rejects only candidates that cannot possibly be accepted.
    if (
      candidateMaxRegionCost >
        this.currentSummary.maxRegionCost + COST_EPSILON ||
      (candidateMaxRegionCost >=
        this.currentSummary.maxRegionCost - COST_EPSILON &&
        candidateTotalRegionCost >=
          this.currentSummary.totalRegionCost - COST_EPSILON)
    ) {
      return
    }

    if (this.boundaryPermutationViolatesForeignEndpointKeepout(permutation)) {
      this.rejectedBoundaryEndpointKeepoutCount += 1
      return
    }

    const region1PhysicalRisks = this.computePhysicalRoutingRisksForRegion(
      this,
      region1Id,
      { permutation },
    )
    const region2PhysicalRisks = this.computePhysicalRoutingRisksForRegion(
      this,
      region2Id,
      { permutation },
    )
    const summary = {
      maxRegionCost: candidateMaxRegionCost,
      maxRoutingRisk: Math.max(
        context.getUnaffectedMaxRoutingRisk(region1Id, region2Id),
        region1PhysicalRisks.groupedRisk,
        region2PhysicalRisks.groupedRisk,
      ),
      maxSegmentRoutingRisk: Math.max(
        context.getUnaffectedMaxSegmentRoutingRisk(region1Id, region2Id),
        region1PhysicalRisks.segmentRisk,
        region2PhysicalRisks.segmentRisk,
      ),
      squaredRoutingRisk:
        this.currentSummary.squaredRoutingRisk -
        context.squaredRoutingRiskByRegion[region1Id]! -
        context.squaredRoutingRiskByRegion[region2Id]! +
        region1PhysicalRisks.groupedRisk ** 2 +
        region2PhysicalRisks.groupedRisk ** 2,
      totalRoutingRisk:
        this.currentSummary.totalRoutingRisk -
        this.routingRiskByRegion[region1Id]! -
        this.routingRiskByRegion[region2Id]! +
        region1PhysicalRisks.groupedRisk +
        region2PhysicalRisks.groupedRisk,
      maxRegionSegmentCount: this.currentSummary.maxRegionSegmentCount,
      squaredRegionSegmentCount: this.currentSummary.squaredRegionSegmentCount,
      totalSegmentLength:
        this.currentSummary.totalSegmentLength -
        this.segmentLengthByRegion[region1Id]! -
        this.segmentLengthByRegion[region2Id]! +
        region1PrimaryMetrics.segmentLength +
        region2PrimaryMetrics.segmentLength,
      totalRegionCost: candidateTotalRegionCost,
    }
    if (!isSwapParetoImprovement(summary, this.currentSummary)) return

    return {
      region1Id,
      region2Id,
      region1Cost: region1PrimaryMetrics.regionCost,
      region2Cost: region2PrimaryMetrics.regionCost,
      region1RoutingRisk: region1PhysicalRisks.groupedRisk,
      region2RoutingRisk: region2PhysicalRisks.groupedRisk,
      region1SegmentRoutingRisk: region1PhysicalRisks.segmentRisk,
      region2SegmentRoutingRisk: region2PhysicalRisks.segmentRisk,
      region1SegmentLength: region1PrimaryMetrics.segmentLength,
      region2SegmentLength: region2PrimaryMetrics.segmentLength,
      summary,
    }
  }

  private compareBoundaryMutationKeys(
    left: BoundaryMutation,
    right: BoundaryMutation,
  ) {
    const leftKey = [
      ...left.permutation.slots.map(({ portId }) => portId),
      ...left.permutation.destinationPortIds,
    ]
    const rightKey = [
      ...right.permutation.slots.map(({ portId }) => portId),
      ...right.permutation.destinationPortIds,
    ]
    for (
      let index = 0;
      index < Math.min(leftKey.length, rightKey.length);
      index++
    ) {
      if (leftKey[index] !== rightKey[index]) {
        return leftKey[index]! - rightKey[index]!
      }
    }
    return leftKey.length - rightKey.length
  }

  private selectBetterBoundaryMutation(
    bestMutation: BoundaryMutation | undefined,
    mutation: BoundaryMutation,
  ) {
    if (!bestMutation) return mutation
    const comparison = compareRegionCostSummaries(
      mutation.summary,
      bestMutation.summary,
    )
    return comparison < 0 ||
      (comparison === 0 &&
        this.compareBoundaryMutationKeys(mutation, bestMutation) < 0)
      ? mutation
      : bestMutation
  }

  private findBestSwapMutation(): BoundaryMutation | undefined {
    const context = this.createBoundaryScoringContext()
    let bestMutation: BoundaryMutation | undefined
    for (const group of this.getBoundaryPortGroups()) {
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
          const permutation: BoundaryPermutation = {
            slots: [left, right],
            destinationPortIds: [right.portId, left.portId],
          }
          const score = this.scoreBoundaryPermutation(permutation, context)
          if (!score) continue
          bestMutation = this.selectBetterBoundaryMutation(bestMutation, {
            kind: "swap",
            permutation,
            ...score,
          })
        }
      }
    }
    return bestMutation
  }

  private findBestCycleMutation(): BoundaryMutation | undefined {
    const context = this.createBoundaryScoringContext()
    let bestMutation: BoundaryMutation | undefined
    for (const group of this.getBoundaryPortGroups()) {
      for (let firstIndex = 0; firstIndex < group.length; firstIndex++) {
        for (
          let secondIndex = firstIndex + 1;
          secondIndex < group.length;
          secondIndex++
        ) {
          for (
            let thirdIndex = secondIndex + 1;
            thirdIndex < group.length;
            thirdIndex++
          ) {
            const slots = [
              group[firstIndex]!,
              group[secondIndex]!,
              group[thirdIndex]!,
            ]
            const routeIds = slots
              .map(({ routeId }) => routeId)
              .filter((routeId): routeId is RouteId => routeId !== undefined)
            if (
              routeIds.length === 0 ||
              new Set(routeIds).size !== routeIds.length
            ) {
              continue
            }
            const destinationOrders = [
              [slots[1]!.portId, slots[2]!.portId, slots[0]!.portId],
              [slots[2]!.portId, slots[0]!.portId, slots[1]!.portId],
            ]
            for (const destinationPortIds of destinationOrders) {
              const permutation: BoundaryPermutation = {
                slots,
                destinationPortIds,
              }
              const score = this.scoreBoundaryPermutation(permutation, context)
              if (!score) continue
              bestMutation = this.selectBetterBoundaryMutation(bestMutation, {
                kind: "cycle",
                permutation,
                ...score,
              })
            }
          }
        }
      }
    }
    return bestMutation
  }

  private preservesRouteLayerChangeCountsAfterPermutation(
    permutation: BoundaryPermutation,
  ): boolean {
    const routeIds = new Set(
      permutation.slots
        .map(({ routeId }) => routeId)
        .filter((routeId): routeId is RouteId => routeId !== undefined),
    )
    const { region1Id, region2Id } = permutation.slots[0]!
    for (const routeId of routeIds) {
      let currentLayerChangeCount = 0
      let permutedLayerChangeCount = 0
      for (const regionId of [region1Id, region2Id]) {
        for (const [
          segmentRouteId,
          originalFromPortId,
          originalToPortId,
        ] of this.state.regionSegments[regionId]!) {
          if (segmentRouteId !== routeId) continue
          const fromPortId = this.remapPortForBoundaryPermutation(
            routeId,
            originalFromPortId,
            permutation,
          )
          const toPortId = this.remapPortForBoundaryPermutation(
            routeId,
            originalToPortId,
            permutation,
          )
          if (
            this.topology.portZ[originalFromPortId] !==
            this.topology.portZ[originalToPortId]
          ) {
            currentLayerChangeCount += 1
          }
          if (
            this.topology.portZ[fromPortId] !== this.topology.portZ[toPortId]
          ) {
            permutedLayerChangeCount += 1
          }
        }
      }
      if (currentLayerChangeCount !== permutedLayerChangeCount) return false
    }
    return true
  }

  private boundaryPermutationViolatesForeignEndpointKeepout(
    permutation: BoundaryPermutation,
  ): boolean {
    if (!this.hasForeignEndpointKeepouts) return false
    // A boundary permutation changes chords only in its two incident regions.
    // Validate those chords incrementally; accepted moves recompute the full
    // per-pad clearance vector once in applyBoundaryMutation.
    const affectedRouteIds = new Set(
      permutation.slots.flatMap(({ routeId }) =>
        routeId === undefined ? [] : [routeId],
      ),
    )
    const { region1Id, region2Id } = permutation.slots[0]!
    for (const regionId of [region1Id, region2Id]) {
      for (const [routeId, storedFromPortId, storedToPortId] of this.state
        .regionSegments[regionId]!) {
        if (!affectedRouteIds.has(routeId)) continue
        const fromPortId = this.remapPortForBoundaryPermutation(
          routeId,
          storedFromPortId,
          permutation,
        )
        const toPortId = this.remapPortForBoundaryPermutation(
          routeId,
          storedToPortId,
          permutation,
        )
        if (
          !this.isRouteSegmentAllowedByForeignEndpointKeepouts(
            routeId,
            fromPortId,
            toPortId,
          )
        ) {
          return true
        }
      }
    }
    return false
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
      new SingleRouteReplacementSolver(
        this,
        this.REROUTE_MAX_ITERATIONS,
        this.hasForeignEndpointKeepouts
          ? (routeId, fromPortId, toPortId) => {
              const allowed =
                this.isRouteSegmentAllowedByForeignEndpointKeepouts(
                  routeId,
                  fromPortId,
                  toPortId,
                )
              if (!allowed) {
                this.prunedRerouteEndpointKeepoutSegmentCount += 1
              }
              return allowed
            }
          : undefined,
      ))
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
        candidateSolver.replacementRouteLayerChangeCountByRouteId[routeId]! >
        this.routeLayerChangeCountByRouteId[routeId]!
      ) {
        this.rejectedRerouteLayerChangeCount += 1
        return { reusable: false }
      }

      const endpointKeepout = this.replacementViolatesForeignEndpointKeepout(
        candidateSolver,
        [routeId],
      )
      if (endpointKeepout.violates) {
        this.rejectedRerouteEndpointKeepoutCount += 1
        return { reusable: true }
      }

      candidateSolver.rescoreForOptimizer(this)
      const scoredState = this.summarizeReplacementSolverState(candidateSolver)
      const { summary } = scoredState
      if (!isRoutingRiskNoWorse(summary, this.currentSummary)) {
        this.rejectedReroutePhysicalRiskCount += 1
        return { reusable: true }
      }
      if (!isParetoImprovement(summary, this.currentSummary)) {
        return { reusable: true }
      }

      return {
        reusable: true,
        mutation: {
          kind: "reroute",
          routeId,
          routeIds: [routeId],
          congestionFactor,
          replacementPath,
          replacementState: candidateSolver.getReplacementState(),
          replacementRouteMetrics: [
            {
              routeId,
              layerChangeCount:
                candidateSolver.replacementRouteLayerChangeCountByRouteId[
                  routeId
                ]!,
              segmentLength:
                candidateSolver.replacementRouteSegmentLengthByRouteId[
                  routeId
                ]!,
              foreignEndpointClearances: endpointKeepout.clearances[0]!,
            },
          ],
          routingRiskByRegion: scoredState.routingRiskByRegion,
          segmentRoutingRiskByRegion: scoredState.segmentRoutingRiskByRegion,
          segmentLengthByRegion: scoredState.segmentLengthByRegion,
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
      const replacementPath =
        candidateSolver.solved && !candidateSolver.failed
          ? candidateSolver.getReplacementPath(routeId)
          : []
      const dependencyRouteIds = new Set(candidateSolver.blockingRouteIds)
      for (const { regionId } of replacementPath) {
        for (const [otherRouteId] of candidateSolver.state.regionSegments[
          regionId
        ]!) {
          if (otherRouteId !== routeId) dependencyRouteIds.add(otherRouteId)
        }
      }
      this.rerouteDependencyRouteIdsByRouteId.set(
        routeId,
        [...dependencyRouteIds].sort((left, right) => left - right),
      )
      if (!candidateSolver.solved || candidateSolver.failed) {
        this.evaluatedMutationCount += 1
        return { reusable: false }
      }
      return scorePreparedCandidate(routeId, congestionFactor, replacementPath)
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

    this.rerouteDependencyRouteIdsByRouteId.clear()
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

  /**
   * Large-neighborhood repair for a one-route local optimum. Any strict peak
   * reduction must change a route using a peak-cost region. Pair it only with
   * routes measured on that route's A* dependency frontier: blocked-port
   * owners and routes contributing cost along the solved replacement corridor.
   * Remove the pair atomically and solve both deterministic route orders
   * against the fixed remainder.
   */
  private findBestPairRerouteMutation(): RerouteMutation | undefined {
    const peakRouteIds = [
      ...new Set(
        this.state.regionIntersectionCaches.flatMap((cache, regionId) =>
          Math.abs(
            cache.existingRegionCost - this.currentSummary.maxRegionCost,
          ) <= COST_EPSILON
            ? this.state.regionSegments[regionId]!.map(([routeId]) => routeId)
            : [],
        ),
      ),
    ].sort((left, right) => left - right)
    if (peakRouteIds.length === 0) return
    const pairKeys = new Set<string>()
    const routePairs: Array<[RouteId, RouteId]> = []
    for (const peakRouteId of peakRouteIds) {
      const blockingRouteIds = new Set(
        this.rerouteDependencyRouteIdsByRouteId.get(peakRouteId) ?? [],
      )
      for (const otherPeakRouteId of peakRouteIds) {
        if (otherPeakRouteId !== peakRouteId) {
          blockingRouteIds.add(otherPeakRouteId)
        }
      }
      for (const segments of this.state.regionSegments) {
        if (!segments.some(([routeId]) => routeId === peakRouteId)) continue
        for (const [routeId] of segments) blockingRouteIds.add(routeId)
      }
      for (const [routeId, dependencies] of this
        .rerouteDependencyRouteIdsByRouteId) {
        if (dependencies.includes(peakRouteId)) blockingRouteIds.add(routeId)
      }
      for (const otherRouteId of blockingRouteIds) {
        if (otherRouteId === peakRouteId) continue
        const leftRouteId = Math.min(peakRouteId, otherRouteId)
        const rightRouteId = Math.max(peakRouteId, otherRouteId)
        const key = `${leftRouteId}:${rightRouteId}`
        if (pairKeys.has(key)) continue
        pairKeys.add(key)
        routePairs.push([leftRouteId, rightRouteId])
      }
    }
    routePairs.sort((left, right) => left[0] - right[0] || left[1] - right[1])
    return this.findBestMultiRouteRerouteMutation(routePairs)
  }

  private getRouteSolveOrders(routeIds: RouteId[]): RouteId[][] {
    if (routeIds.length <= 1) return [[...routeIds]]
    const orders: RouteId[][] = []
    for (let index = 0; index < routeIds.length; index++) {
      const routeId = routeIds[index]!
      const remainder = [
        ...routeIds.slice(0, index),
        ...routeIds.slice(index + 1),
      ]
      for (const suffix of this.getRouteSolveOrders(remainder)) {
        orders.push([routeId, ...suffix])
      }
    }
    return orders
  }

  private compareRouteIdLists(left: RouteId[], right: RouteId[]) {
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      if (left[index] !== right[index]) return left[index]! - right[index]!
    }
    return left.length - right.length
  }

  private findBestMultiRouteRerouteMutation(
    routeSets: RouteId[][],
  ): RerouteMutation | undefined {
    const routeSetCandidates = routeSets
      .map((routeIds) => ({
        routeIds,
        optimisticSummary: this.summarizeStateWithoutRoutes(routeIds),
      }))
      .sort(
        (left, right) =>
          compareRegionCostSummaries(
            left.optimisticSummary,
            right.optimisticSummary,
          ) || this.compareRouteIdLists(left.routeIds, right.routeIds),
      )

    const candidateSolver = (this.routeReplacementSolver ??=
      new SingleRouteReplacementSolver(
        this,
        this.REROUTE_MAX_ITERATIONS,
        this.hasForeignEndpointKeepouts
          ? (routeId, fromPortId, toPortId) => {
              const allowed =
                this.isRouteSegmentAllowedByForeignEndpointKeepouts(
                  routeId,
                  fromPortId,
                  toPortId,
                )
              if (!allowed) {
                this.prunedRerouteEndpointKeepoutSegmentCount += 1
              }
              return allowed
            }
          : undefined,
      ))
    let bestMutation: RerouteMutation | undefined

    const selectBetterMutation = (mutation: RerouteMutation) => {
      if (!bestMutation) {
        bestMutation = mutation
        return
      }
      const comparison = compareRegionCostSummaries(
        mutation.summary,
        bestMutation.summary,
      )
      if (
        comparison < 0 ||
        (comparison === 0 &&
          this.compareRouteIdLists(mutation.routeIds, bestMutation.routeIds) <
            0)
      ) {
        bestMutation = mutation
      }
    }

    const scoreSolvedCandidate = (
      routeIds: RouteId[],
      solveOrder: RouteId[],
    ) => {
      this.evaluatedMutationCount += 1
      if (!candidateSolver.solved || candidateSolver.failed) return

      for (const routeId of solveOrder) {
        if (
          candidateSolver.replacementRouteSegmentCountByRouteId[routeId]! >
          this.initialRouteSegmentCounts[routeId]! +
            this.MAX_REROUTE_SEGMENT_INCREASE
        ) {
          this.rejectedRerouteDetourCount += 1
          return
        }
        if (
          candidateSolver.replacementRouteLayerChangeCountByRouteId[routeId]! >
          this.routeLayerChangeCountByRouteId[routeId]!
        ) {
          this.rejectedRerouteLayerChangeCount += 1
          return
        }
      }

      const endpointKeepout = this.replacementViolatesForeignEndpointKeepout(
        candidateSolver,
        solveOrder,
      )
      if (endpointKeepout.violates) {
        this.rejectedRerouteEndpointKeepoutCount += 1
        return
      }

      candidateSolver.rescoreForOptimizer(this)
      const scoredState = this.summarizeReplacementSolverState(candidateSolver)
      const { summary } = scoredState
      if (!isRoutingRiskNoWorse(summary, this.currentSummary)) {
        this.rejectedReroutePhysicalRiskCount += 1
        return
      }
      if (!isParetoImprovement(summary, this.currentSummary)) return

      selectBetterMutation({
        kind: "reroute",
        routeId: Math.min(...routeIds),
        routeIds: [...solveOrder],
        congestionFactor: 0,
        replacementPath: [],
        replacementState: candidateSolver.getReplacementState(),
        replacementRouteMetrics: solveOrder.map((routeId, routeIndex) => ({
          routeId,
          layerChangeCount:
            candidateSolver.replacementRouteLayerChangeCountByRouteId[routeId]!,
          segmentLength:
            candidateSolver.replacementRouteSegmentLengthByRouteId[routeId]!,
          foreignEndpointClearances: endpointKeepout.clearances[routeIndex]!,
        })),
        routingRiskByRegion: scoredState.routingRiskByRegion,
        segmentRoutingRiskByRegion: scoredState.segmentRoutingRiskByRegion,
        segmentLengthByRegion: scoredState.segmentLengthByRegion,
        summary,
      })
    }

    for (
      let candidateIndex = 0;
      candidateIndex < routeSetCandidates.length;
      candidateIndex++
    ) {
      const { routeIds, optimisticSummary } =
        routeSetCandidates[candidateIndex]!
      const solveOrders = this.getRouteSolveOrders(routeIds)
      if (
        compareRegionCostSummaries(
          optimisticSummary,
          bestMutation?.summary ?? this.currentSummary,
        ) >= 0
      ) {
        this.prunedRerouteSearchCount +=
          (routeSetCandidates.length - candidateIndex) * solveOrders.length
        break
      }
      for (const solveOrder of solveOrders) {
        candidateSolver.resetForRoutes(this, solveOrder, 0)
        candidateSolver.solve()
        this.rerouteSearchCount += 1
        this.rerouteSearchIterationCount += candidateSolver.iterations
        scoreSolvedCandidate(routeIds, solveOrder)
      }
    }
    return bestMutation
  }

  private computeSegmentLength(
    solver: TinyHyperGraphSolver,
    fromPortId: PortId,
    toPortId: PortId,
  ): number {
    return Math.hypot(
      solver.topology.portX[toPortId]! - solver.topology.portX[fromPortId]!,
      solver.topology.portY[toPortId]! - solver.topology.portY[fromPortId]!,
    )
  }

  private queryTerminalKeepoutIndexes(
    startX: number,
    startY: number,
    startZ: number,
    endX: number,
    endY: number,
    endZ: number,
  ): number[] {
    if (!this.hasForeignEndpointKeepouts) return []
    this.terminalKeepoutBroadPhaseQueryCount += 1
    const minCellX = Math.floor(
      Math.min(startX, endX) / this.terminalKeepoutCellSize,
    )
    const maxCellX = Math.floor(
      Math.max(startX, endX) / this.terminalKeepoutCellSize,
    )
    const minCellY = Math.floor(
      Math.min(startY, endY) / this.terminalKeepoutCellSize,
    )
    const maxCellY = Math.floor(
      Math.max(startY, endY) / this.terminalKeepoutCellSize,
    )
    const keepoutIndexes = new Set<number>()
    for (let z = Math.min(startZ, endZ); z <= Math.max(startZ, endZ); z++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
          const cellIndexes = this.terminalKeepoutIndexesByCell.get(
            getTerminalKeepoutCellKey(z, cellX, cellY),
          )
          if (!cellIndexes) continue
          for (const keepoutIndex of cellIndexes) {
            keepoutIndexes.add(keepoutIndex)
          }
        }
      }
    }
    this.terminalKeepoutBroadPhaseCandidateCount += keepoutIndexes.size
    return [...keepoutIndexes]
  }

  private computeRouteForeignEndpointClearances(
    solver: TinyHyperGraphSolver,
    routeId: RouteId,
    permutation?: BoundaryPermutation,
  ): Float64Array {
    const clearances = new Float64Array(this.terminalKeepouts.length)
    clearances.fill(Number.POSITIVE_INFINITY)
    const routeNetId = this.problem.routeNet[routeId]!
    for (
      let regionId = 0;
      regionId < solver.state.regionSegments.length;
      regionId++
    ) {
      for (const [segmentRouteId, storedFromPortId, storedToPortId] of solver
        .state.regionSegments[regionId]!) {
        if (segmentRouteId !== routeId) continue
        const fromPortId = permutation
          ? this.remapPortForBoundaryPermutation(
              routeId,
              storedFromPortId,
              permutation,
            )
          : storedFromPortId
        const toPortId = permutation
          ? this.remapPortForBoundaryPermutation(
              routeId,
              storedToPortId,
              permutation,
            )
          : storedToPortId
        const startX = solver.topology.portX[fromPortId]!
        const startY = solver.topology.portY[fromPortId]!
        const startZ = solver.topology.portZ[fromPortId]!
        const endX = solver.topology.portX[toPortId]!
        const endY = solver.topology.portY[toPortId]!
        const endZ = solver.topology.portZ[toPortId]!
        for (const keepoutIndex of this.queryTerminalKeepoutIndexes(
          startX,
          startY,
          startZ,
          endX,
          endY,
          endZ,
        )) {
          const keepout = this.terminalKeepouts[keepoutIndex]!
          if (keepout.netId === routeNetId) continue
          this.terminalKeepoutExactCheckCount += 1
          clearances[keepoutIndex] = Math.min(
            clearances[keepoutIndex]!,
            getSegmentToTerminalKeepoutClearance({
              startX,
              startY,
              startZ,
              endX,
              endY,
              endZ,
              keepout,
            }),
          )
        }
      }
    }
    return clearances
  }

  private isRouteSegmentAllowedByForeignEndpointKeepouts(
    routeId: RouteId,
    fromPortId: PortId,
    toPortId: PortId,
  ): boolean {
    if (!this.hasForeignEndpointKeepouts) return true
    const baselineClearances =
      this.routeForeignEndpointClearancesByRouteId[routeId]!
    const routeNetId = this.problem.routeNet[routeId]!
    const startX = this.topology.portX[fromPortId]!
    const startY = this.topology.portY[fromPortId]!
    const startZ = this.topology.portZ[fromPortId]!
    const endX = this.topology.portX[toPortId]!
    const endY = this.topology.portY[toPortId]!
    const endZ = this.topology.portZ[toPortId]!
    for (const keepoutIndex of this.queryTerminalKeepoutIndexes(
      startX,
      startY,
      startZ,
      endX,
      endY,
      endZ,
    )) {
      const keepout = this.terminalKeepouts[keepoutIndex]!
      if (keepout.netId === routeNetId) continue
      this.terminalKeepoutExactCheckCount += 1
      const clearance = getSegmentToTerminalKeepoutClearance({
        startX,
        startY,
        startZ,
        endX,
        endY,
        endZ,
        keepout,
      })
      if (
        clearance + COST_EPSILON <
        Math.min(0, baselineClearances[keepoutIndex]!)
      ) {
        return false
      }
    }
    return true
  }

  private getMinimumForeignEndpointClearance(): number {
    let minimumClearance = Number.POSITIVE_INFINITY
    for (const routeClearances of this
      .routeForeignEndpointClearancesByRouteId) {
      for (const clearance of routeClearances) {
        minimumClearance = Math.min(minimumClearance, clearance)
      }
    }
    return minimumClearance
  }

  private replacementViolatesForeignEndpointKeepout(
    solver: TinyHyperGraphSolver,
    routeIds: readonly RouteId[],
    permutation?: BoundaryPermutation,
  ): { violates: boolean; clearances: Float64Array[] } {
    const clearances = routeIds.map((routeId) =>
      this.computeRouteForeignEndpointClearances(solver, routeId, permutation),
    )
    return {
      violates: routeIds.some((routeId, routeIndex) => {
        const candidateClearances = clearances[routeIndex]!
        const currentClearances =
          this.routeForeignEndpointClearancesByRouteId[routeId]!
        for (
          let keepoutIndex = 0;
          keepoutIndex < candidateClearances.length;
          keepoutIndex++
        ) {
          if (
            candidateClearances[keepoutIndex]! + COST_EPSILON <
            Math.min(0, currentClearances[keepoutIndex]!)
          ) {
            return true
          }
        }
        return false
      }),
      clearances,
    }
  }

  private recomputeRouteMetrics(routeIds: readonly RouteId[]) {
    const routeIdSet = new Set(routeIds)
    for (const routeId of routeIdSet) {
      this.routeLayerChangeCountByRouteId[routeId] = 0
      this.routeSegmentLengthByRouteId[routeId] = 0
    }
    for (const segments of this.state.regionSegments) {
      for (const [routeId, fromPortId, toPortId] of segments) {
        if (!routeIdSet.has(routeId)) continue
        if (this.topology.portZ[fromPortId] !== this.topology.portZ[toPortId]) {
          this.routeLayerChangeCountByRouteId[routeId] += 1
        }
        this.routeSegmentLengthByRouteId[routeId] += this.computeSegmentLength(
          this,
          fromPortId,
          toPortId,
        )
      }
    }
    for (const routeId of routeIdSet) {
      this.routeForeignEndpointClearancesByRouteId[routeId] =
        this.computeRouteForeignEndpointClearances(this, routeId)
    }
  }

  private computeRegionMetricsWithoutRoutes(
    regionId: RegionId,
    removedRouteIds: ReadonlySet<RouteId>,
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
      if (removedRouteIds.has(routeId)) continue
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

    const physicalRisks = this.computePhysicalRoutingRisksForRegion(
      this,
      regionId,
      { removedRouteIds },
    )
    return {
      regionCost: this.computeRegionCostForRegion(
        regionId,
        sameLayerIntersections,
        crossingLayerIntersections,
        entryExitLayerChanges,
        intersectionOwnerIds.length,
      ),
      routingRisk: physicalRisks.groupedRisk,
      segmentRoutingRisk: physicalRisks.segmentRisk,
      segmentCount: remainingSegmentCount,
    }
  }

  private summarizeSolverState(
    solver: TinyHyperGraphSolver,
  ): ScoredSolverState {
    let maxRegionCost = 0
    let totalRegionCost = 0
    let maxRoutingRisk = 0
    let squaredRoutingRisk = 0
    let totalRoutingRisk = 0
    let maxSegmentRoutingRisk = 0
    let maxRegionSegmentCount = 0
    let squaredRegionSegmentCount = 0
    let totalSegmentLength = 0
    const routingRiskByRegion = new Float64Array(
      solver.state.regionIntersectionCaches.length,
    )
    const segmentRoutingRiskByRegion = new Float64Array(
      solver.state.regionIntersectionCaches.length,
    )
    const segmentLengthByRegion = new Float64Array(
      solver.state.regionIntersectionCaches.length,
    )
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
      for (const [, fromPortId, toPortId] of solver.state.regionSegments[
        regionId
      ]!) {
        const segmentLength = this.computeSegmentLength(
          solver,
          fromPortId,
          toPortId,
        )
        segmentLengthByRegion[regionId] += segmentLength
        totalSegmentLength += segmentLength
      }
      const { groupedRisk: routingRisk, segmentRisk } =
        this.computePhysicalRoutingRisksForRegion(solver, regionId)
      routingRiskByRegion[regionId] = routingRisk
      segmentRoutingRiskByRegion[regionId] = segmentRisk
      maxRoutingRisk = Math.max(maxRoutingRisk, routingRisk)
      squaredRoutingRisk += routingRisk * routingRisk
      totalRoutingRisk += routingRisk
      maxSegmentRoutingRisk = Math.max(maxSegmentRoutingRisk, segmentRisk)
    }
    return {
      summary: {
        maxRegionCost,
        totalRegionCost,
        maxRegionSegmentCount,
        squaredRegionSegmentCount,
        totalSegmentLength,
        maxRoutingRisk,
        squaredRoutingRisk,
        totalRoutingRisk,
        maxSegmentRoutingRisk,
      },
      routingRiskByRegion,
      segmentRoutingRiskByRegion,
      segmentLengthByRegion,
    }
  }

  /**
   * Scores a copy-on-write replacement state. Regions outside the removed and
   * replacement corridors are byte-for-byte identical to the current state,
   * so reuse their already validated geometry metrics and recompute only the
   * dirty frontier. The final objective is still aggregated across every
   * region, preserving exact max and total comparisons.
   */
  private summarizeReplacementSolverState(
    solver: SingleRouteReplacementSolver,
  ): ScoredSolverState {
    const routingRiskByRegion = new Float64Array(this.routingRiskByRegion)
    const segmentRoutingRiskByRegion = new Float64Array(
      this.segmentRoutingRiskByRegion,
    )
    const segmentLengthByRegion = new Float64Array(this.segmentLengthByRegion)

    for (const regionId of solver.getChangedRegionIds()) {
      let segmentLength = 0
      for (const [, fromPortId, toPortId] of solver.state.regionSegments[
        regionId
      ]!) {
        segmentLength += this.computeSegmentLength(solver, fromPortId, toPortId)
      }
      segmentLengthByRegion[regionId] = segmentLength
      const { groupedRisk, segmentRisk } =
        this.computePhysicalRoutingRisksForRegion(solver, regionId)
      routingRiskByRegion[regionId] = groupedRisk
      segmentRoutingRiskByRegion[regionId] = segmentRisk
    }

    let maxRegionCost = 0
    let totalRegionCost = 0
    let maxRoutingRisk = 0
    let squaredRoutingRisk = 0
    let totalRoutingRisk = 0
    let maxSegmentRoutingRisk = 0
    let maxRegionSegmentCount = 0
    let squaredRegionSegmentCount = 0
    let totalSegmentLength = 0
    for (
      let regionId = 0;
      regionId < solver.state.regionIntersectionCaches.length;
      regionId++
    ) {
      const cache = solver.state.regionIntersectionCaches[regionId]!
      const routingRisk = routingRiskByRegion[regionId]!
      maxRegionCost = Math.max(maxRegionCost, cache.existingRegionCost)
      totalRegionCost += cache.existingRegionCost
      if (this.REGION_COST_MODEL === "routing-complexity") {
        maxRegionSegmentCount = Math.max(
          maxRegionSegmentCount,
          cache.existingSegmentCount,
        )
        squaredRegionSegmentCount += cache.existingSegmentCount ** 2
      }
      totalSegmentLength += segmentLengthByRegion[regionId]!
      maxRoutingRisk = Math.max(maxRoutingRisk, routingRisk)
      squaredRoutingRisk += routingRisk * routingRisk
      totalRoutingRisk += routingRisk
      maxSegmentRoutingRisk = Math.max(
        maxSegmentRoutingRisk,
        segmentRoutingRiskByRegion[regionId]!,
      )
    }

    return {
      summary: {
        maxRegionCost,
        totalRegionCost,
        maxRegionSegmentCount,
        squaredRegionSegmentCount,
        totalSegmentLength,
        maxRoutingRisk,
        squaredRoutingRisk,
        totalRoutingRisk,
        maxSegmentRoutingRisk,
      },
      routingRiskByRegion,
      segmentRoutingRiskByRegion,
      segmentLengthByRegion,
    }
  }

  private summarizeStateWithoutRoute(
    routeId: RouteId,
  ): UnravelRegionCostSummary {
    return this.summarizeStateWithoutRoutes([routeId])
  }

  private summarizeStateWithoutRoutes(
    routeIds: RouteId[],
  ): UnravelRegionCostSummary {
    const removedRouteIds = new Set(routeIds)
    let maxRegionCost = 0
    let totalRegionCost = 0
    let maxRoutingRisk = 0
    let squaredRoutingRisk = 0
    let totalRoutingRisk = 0
    let maxSegmentRoutingRisk = 0
    let maxRegionSegmentCount = 0
    let squaredRegionSegmentCount = 0
    const totalSegmentLength =
      this.currentSummary.totalSegmentLength -
      routeIds.reduce(
        (total, routeId) => total + this.routeSegmentLengthByRouteId[routeId]!,
        0,
      )

    for (let regionId = 0; regionId < this.topology.regionCount; regionId++) {
      const cache = this.state.regionIntersectionCaches[regionId]!
      const regionMetrics = this.state.regionSegments[regionId]!.some(
        ([segmentRouteId]) => removedRouteIds.has(segmentRouteId),
      )
        ? this.computeRegionMetricsWithoutRoutes(regionId, removedRouteIds)
        : {
            regionCost: cache.existingRegionCost,
            routingRisk: this.routingRiskByRegion[regionId]!,
            segmentRoutingRisk: this.segmentRoutingRiskByRegion[regionId]!,
            segmentCount: cache.existingSegmentCount,
          }
      maxRegionCost = Math.max(maxRegionCost, regionMetrics.regionCost)
      totalRegionCost += regionMetrics.regionCost
      maxRoutingRisk = Math.max(maxRoutingRisk, regionMetrics.routingRisk)
      squaredRoutingRisk += regionMetrics.routingRisk ** 2
      totalRoutingRisk += regionMetrics.routingRisk
      maxSegmentRoutingRisk = Math.max(
        maxSegmentRoutingRisk,
        regionMetrics.segmentRoutingRisk,
      )
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
      totalSegmentLength,
      maxRoutingRisk,
      squaredRoutingRisk,
      totalRoutingRisk,
      maxSegmentRoutingRisk,
    }
  }

  private computePrimaryRegionMetricsAfterPermutation(
    regionId: RegionId,
    permutation: BoundaryPermutation,
  ) {
    const intersectionOwnerIds: number[] = []
    const lesserAngles: number[] = []
    const greaterAngles: number[] = []
    const layerMasks: number[] = []
    const seenIntersectionOwnerIds = new Set<number>()
    let entryExitLayerChanges = 0
    let segmentLength = 0

    for (const [routeId, originalFromPortId, originalToPortId] of this.state
      .regionSegments[regionId]!) {
      const fromPortId = this.remapPortForBoundaryPermutation(
        routeId,
        originalFromPortId,
        permutation,
      )
      const toPortId = this.remapPortForBoundaryPermutation(
        routeId,
        originalToPortId,
        permutation,
      )

      segmentLength += this.computeSegmentLength(this, fromPortId, toPortId)

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
      segmentLength,
    }
  }

  private applyBoundaryMutation(mutation: BoundaryMutation) {
    // Cached replacement paths were expressed in the old boundary-port
    // coordinates. Carry them through the same atomic permutation so they
    // remain candidates after the untwist descent. Every transformed path is
    // still ownership-validated and fully rescored before use.
    for (const cachedPath of this.pendingReroutePaths) {
      for (const segment of cachedPath.replacementPath) {
        segment.fromPortId = this.remapPortForBoundaryPermutation(
          cachedPath.routeId,
          segment.fromPortId,
          mutation.permutation,
        )
        segment.toPortId = this.remapPortForBoundaryPermutation(
          cachedPath.routeId,
          segment.toPortId,
          mutation.permutation,
        )
      }
    }

    for (const regionId of [mutation.region1Id, mutation.region2Id]) {
      for (const segment of this.state.regionSegments[regionId]!) {
        segment[1] = this.remapPortForBoundaryPermutation(
          segment[0],
          segment[1],
          mutation.permutation,
        )
        segment[2] = this.remapPortForBoundaryPermutation(
          segment[0],
          segment[2],
          mutation.permutation,
        )
      }
    }

    for (let index = 0; index < mutation.permutation.slots.length; index++) {
      const source = mutation.permutation.slots[index]!
      const destinationPortId = mutation.permutation.destinationPortIds[index]!
      this.state.portAssignment[destinationPortId] =
        source.routeId === undefined
          ? -1
          : this.problem.routeNet[source.routeId]!
    }
    this.rebuildRegionCache(mutation.region1Id)
    this.rebuildRegionCache(mutation.region2Id)
    this.routingRiskByRegion[mutation.region1Id] = mutation.region1RoutingRisk
    this.routingRiskByRegion[mutation.region2Id] = mutation.region2RoutingRisk
    this.segmentRoutingRiskByRegion[mutation.region1Id] =
      mutation.region1SegmentRoutingRisk
    this.segmentRoutingRiskByRegion[mutation.region2Id] =
      mutation.region2SegmentRoutingRisk
    this.segmentLengthByRegion[mutation.region1Id] =
      mutation.region1SegmentLength
    this.segmentLengthByRegion[mutation.region2Id] =
      mutation.region2SegmentLength
    this.recomputeRouteMetrics(
      mutation.permutation.slots.flatMap(({ routeId }) =>
        routeId === undefined ? [] : [routeId],
      ),
    )
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
    this.routingRiskByRegion.set(mutation.routingRiskByRegion)
    this.segmentRoutingRiskByRegion.set(mutation.segmentRoutingRiskByRegion)
    this.segmentLengthByRegion.set(mutation.segmentLengthByRegion)
    for (const {
      routeId,
      layerChangeCount,
      segmentLength,
      foreignEndpointClearances,
    } of mutation.replacementRouteMetrics) {
      this.routeLayerChangeCountByRouteId[routeId] = layerChangeCount
      this.routeSegmentLengthByRouteId[routeId] = segmentLength
      this.routeForeignEndpointClearancesByRouteId[routeId] =
        foreignEndpointClearances
    }
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
    const finalPeakRegionIds = this.state.regionIntersectionCaches
      .map((cache, regionId) => ({
        regionId,
        cost: cache.existingRegionCost,
      }))
      .filter(
        ({ cost }) =>
          Math.abs(cost - this.currentSummary.maxRegionCost) <= COST_EPSILON,
      )
      .map(({ regionId }) => regionId)
    const finalPeakRouteIds = [
      ...new Set(
        finalPeakRegionIds.flatMap((regionId) =>
          this.state.regionSegments[regionId]!.map(([routeId]) => routeId),
        ),
      ),
    ].sort((left, right) => left - right)
    this.stats = {
      ...this.stats,
      finalMaxRegionCost: this.currentSummary.maxRegionCost,
      finalTotalRegionCost: this.currentSummary.totalRegionCost,
      finalTotalSegmentLength: this.currentSummary.totalSegmentLength,
      finalMinForeignEndpointClearance:
        this.getMinimumForeignEndpointClearance(),
      acceptedMutationCount: this.acceptedMutationCount,
      acceptedSwapMutationCount: this.acceptedSwapMutationCount,
      acceptedCycleMutationCount: this.acceptedCycleMutationCount,
      acceptedRerouteMutationCount: this.acceptedRerouteMutationCount,
      acceptedPairRerouteMutationCount: this.acceptedPairRerouteMutationCount,
      evaluatedMutationCount: this.evaluatedMutationCount,
      rejectedRerouteDetourCount: this.rejectedRerouteDetourCount,
      rejectedRerouteLayerChangeCount: this.rejectedRerouteLayerChangeCount,
      rejectedReroutePhysicalRiskCount: this.rejectedReroutePhysicalRiskCount,
      rejectedRerouteEndpointKeepoutCount:
        this.rejectedRerouteEndpointKeepoutCount,
      prunedRerouteEndpointKeepoutSegmentCount:
        this.prunedRerouteEndpointKeepoutSegmentCount,
      rejectedBoundaryEndpointKeepoutCount:
        this.rejectedBoundaryEndpointKeepoutCount,
      terminalKeepoutCount: this.terminalKeepouts.length,
      terminalKeepoutCellSize: this.terminalKeepoutCellSize,
      terminalKeepoutBroadPhaseQueryCount:
        this.terminalKeepoutBroadPhaseQueryCount,
      terminalKeepoutBroadPhaseCandidateCount:
        this.terminalKeepoutBroadPhaseCandidateCount,
      terminalKeepoutExactCheckCount: this.terminalKeepoutExactCheckCount,
      rejectedCrossLayerSwapCount: this.rejectedCrossLayerSwapCount,
      prunedRerouteSearchCount: this.prunedRerouteSearchCount,
      rerouteSearchIterationCount: this.rerouteSearchIterationCount,
      rerouteSearchCount: this.rerouteSearchCount,
      reusedRerouteCandidateCount: this.reusedRerouteCandidateCount,
      optimizationStopReason: reason,
      finalPeakRegionIds,
      finalPeakRouteIds,
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
