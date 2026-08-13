import {
  createEmptyRegionIntersectionCache,
  getTinyHyperGraphSolverOptions,
  type RegionCostSummary,
  type TinyHyperGraphProblem,
  TinyHyperGraphSolver,
  type TinyHyperGraphSolverOptions,
} from "./core"
import type {
  NetId,
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
  summary: RegionCostSummary
}

interface RerouteMutation {
  kind: "reroute"
  routeId: RouteId
  congestionFactor: number
  solver: TinyHyperGraphSolver
  summary: RegionCostSummary
}

type UnravelMutation = SwapMutation | RerouteMutation

export interface UnravelTinyHyperGraphSolverOptions
  extends TinyHyperGraphSolverOptions {
  /** Maximum number of beneficial swaps or route replacements to accept. */
  MAX_MUTATIONS?: number
  /** Number of the most expensive regions whose routes are considered. */
  MAX_HOT_REGIONS?: number
  /** Iteration cap for each single-route replacement search. */
  REROUTE_MAX_ITERATIONS?: number
  /** Maximum routes from the hot regions evaluated per mutation. */
  MAX_REROUTE_ROUTES?: number
  /** Congestion multipliers explored for each route replacement. */
  REROUTE_CONGESTION_FACTORS?: number[]
  /** Maximum extra region segments accepted for an individual rerouted route. */
  MAX_REROUTE_SEGMENT_INCREASE?: number
  /** Stop after reducing the input maximum region cost by this fraction. */
  TARGET_MAX_REGION_COST_REDUCTION_RATIO?: number
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
  left: RegionCostSummary,
  right: RegionCostSummary,
) => {
  if (Math.abs(left.maxRegionCost - right.maxRegionCost) > COST_EPSILON) {
    return left.maxRegionCost - right.maxRegionCost
  }

  if (Math.abs(left.totalRegionCost - right.totalRegionCost) > COST_EPSILON) {
    return left.totalRegionCost - right.totalRegionCost
  }

  return 0
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
  routeNet: new Int32Array(problem.routeNet),
  regionNetId: new Int32Array(problem.regionNetId),
  portPenalty:
    problem.portPenalty === undefined
      ? undefined
      : new Float64Array(problem.portPenalty),
})

class SingleRouteReplacementSolver extends TinyHyperGraphSolver {
  constructor(
    inputSolver: TinyHyperGraphSolver,
    routeIdToReplace: RouteId,
    congestionFactor: number,
    maxIterations: number,
  ) {
    super(
      inputSolver.topology,
      createWholeGraphProblem(
        inputSolver.problem,
        inputSolver.topology.portCount,
      ),
      {
        ...getTinyHyperGraphSolverOptions(inputSolver),
        STATIC_REACHABILITY_PRECHECK: false,
        ACCEPT_BEST_SOLUTION_ON_TIMEOUT: false,
        GREEDY_FINAL_ROUTE_ITERS: 0,
        RIP_THRESHOLD_RAMP_ATTEMPTS: 0,
        MAX_ITERATIONS: maxIterations,
      },
    )

    this.state.portAssignment.fill(-1)
    this.state.regionSegments = Array.from(
      { length: this.topology.regionCount },
      () => [],
    )
    this.state.regionIntersectionCaches = Array.from(
      { length: this.topology.regionCount },
      () => createEmptyRegionIntersectionCache(),
    )

    for (
      let regionId = 0;
      regionId < inputSolver.state.regionSegments.length;
      regionId++
    ) {
      for (const [routeId, fromPortId, toPortId] of inputSolver.state
        .regionSegments[regionId]!) {
        if (routeId === routeIdToReplace) continue
        const routeNetId = this.problem.routeNet[routeId]!
        this.state.currentRouteNetId = routeNetId
        this.state.regionSegments[regionId]!.push([
          routeId,
          fromPortId,
          toPortId,
        ])
        this.state.portAssignment[fromPortId] = routeNetId
        this.state.portAssignment[toPortId] = routeNetId
        this.appendSegmentToRegionCache(regionId, fromPortId, toPortId)
      }
    }

    this.state.currentRouteId = undefined
    this.state.currentRouteNetId = undefined
    this.state.unroutedRoutes = [routeIdToReplace]
    this.state.candidateQueue.clear()
    this.resetCandidateBestCosts()
    this.state.goalPortId = -1
    this.state.regionCongestionCost = Float64Array.from(
      inputSolver.state.regionIntersectionCaches,
      (cache) => cache.existingRegionCost * congestionFactor,
    )
  }

  override onAllRoutesRouted() {
    for (let regionId = 0; regionId < this.topology.regionCount; regionId++) {
      this.state.regionSegments[regionId]!.sort(
        (left, right) => left[0] - right[0],
      )
      this.state.regionIntersectionCaches[regionId] =
        createEmptyRegionIntersectionCache()
      for (const [routeId, fromPortId, toPortId] of this.state.regionSegments[
        regionId
      ]!) {
        this.state.currentRouteNetId = this.problem.routeNet[routeId]
        this.appendSegmentToRegionCache(regionId, fromPortId, toPortId)
      }
    }
    this.state.currentRouteId = undefined
    this.state.currentRouteNetId = undefined
    this.solved = true
  }

  override onOutOfCandidates() {
    this.failed = true
    this.error = "No replacement path was found for the selected route"
  }
}

/**
 * Improves a solved hypergraph with boundary-port swaps and targeted route
 * replacements through its hottest regions. Boundary mutations change both
 * sides together, and replacement candidates retain every other route. Only
 * mutations that reduce the lexicographic (maximum region cost, total region
 * cost) objective are kept.
 */
export class UnravelTinyHyperGraphSolver extends TinyHyperGraphSolver {
  MAX_MUTATIONS = 16
  MAX_HOT_REGIONS = 1
  REROUTE_MAX_ITERATIONS = 10_000
  MAX_REROUTE_ROUTES = 24
  REROUTE_CONGESTION_FACTORS = [0, 2]
  MAX_REROUTE_SEGMENT_INCREASE = 4
  TARGET_MAX_REGION_COST_REDUCTION_RATIO = 0.51

  readonly inputSolver: TinyHyperGraphSolver
  initialSummary: RegionCostSummary
  currentSummary: RegionCostSummary
  acceptedMutationCount = 0
  evaluatedMutationCount = 0
  rejectedRerouteDetourCount = 0

  private readonly endpointPortMask: Int8Array
  private readonly initialRouteSegmentCounts: Int32Array

  constructor(
    inputSolver: TinyHyperGraphSolver,
    options?: UnravelTinyHyperGraphSolverOptions,
  ) {
    if (!inputSolver.solved || inputSolver.failed) {
      throw new Error(
        "UnravelTinyHyperGraphSolver requires a successfully solved input solver",
      )
    }

    super(inputSolver.topology, inputSolver.problem, {
      ...getTinyHyperGraphSolverOptions(inputSolver),
      STATIC_REACHABILITY_PRECHECK: false,
      ...options,
    })
    this.inputSolver = inputSolver
    if (options?.MAX_MUTATIONS !== undefined) {
      this.MAX_MUTATIONS = Math.max(0, Math.floor(options.MAX_MUTATIONS))
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
    if (options?.TARGET_MAX_REGION_COST_REDUCTION_RATIO !== undefined) {
      this.TARGET_MAX_REGION_COST_REDUCTION_RATIO = Math.min(
        1,
        Math.max(0, options.TARGET_MAX_REGION_COST_REDUCTION_RATIO),
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

    this.endpointPortMask = new Int8Array(this.topology.portCount)
    this.initialRouteSegmentCounts = new Int32Array(this.problem.routeCount)
    for (let routeId = 0; routeId < this.problem.routeCount; routeId++) {
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
      evaluatedMutationCount: 0,
      rejectedRerouteDetourCount: 0,
    }

    if (this.MAX_MUTATIONS === 0) {
      this.finishOptimization("mutation_limit")
    }
  }

  override _step() {
    if (
      this.currentSummary.maxRegionCost <=
      this.initialSummary.maxRegionCost *
        (1 - this.TARGET_MAX_REGION_COST_REDUCTION_RATIO)
    ) {
      this.finishOptimization("target_reached")
      return
    }

    if (this.acceptedMutationCount >= this.MAX_MUTATIONS) {
      this.finishOptimization("mutation_limit")
      return
    }

    const swapMutation = this.findBestSwapMutation()
    const rerouteMutation = this.findBestRerouteMutation()
    const mutation = this.selectBetterMutation(swapMutation, rerouteMutation)
    if (!mutation) {
      this.finishOptimization("local_optimum")
      return
    }

    if (mutation.kind === "swap") {
      this.applySwapMutation(mutation)
    } else {
      this.applyRerouteMutation(mutation)
    }
    this.acceptedMutationCount += 1
    this.currentSummary = mutation.summary
    this.stats = {
      ...this.stats,
      finalMaxRegionCost: this.currentSummary.maxRegionCost,
      finalTotalRegionCost: this.currentSummary.totalRegionCost,
      acceptedMutationCount: this.acceptedMutationCount,
      evaluatedMutationCount: this.evaluatedMutationCount,
      rejectedRerouteDetourCount: this.rejectedRerouteDetourCount,
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

  private summarizeCurrentState(): RegionCostSummary {
    let maxRegionCost = 0
    let totalRegionCost = 0

    for (const cache of this.state.regionIntersectionCaches) {
      maxRegionCost = Math.max(maxRegionCost, cache.existingRegionCost)
      totalRegionCost += cache.existingRegionCost
    }

    return { maxRegionCost, totalRegionCost }
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
          this.evaluatedMutationCount += 1

          const region1Cost = this.computeRegionCostAfterSwap(
            region1Id,
            left,
            right,
          )
          const region2Cost = this.computeRegionCostAfterSwap(
            region2Id,
            left,
            right,
          )
          const summary = {
            maxRegionCost: Math.max(
              unaffectedMaxRegionCost,
              region1Cost,
              region2Cost,
            ),
            totalRegionCost:
              this.currentSummary.totalRegionCost -
              oldRegion1Cost -
              oldRegion2Cost +
              region1Cost +
              region2Cost,
          }
          if (compareRegionCostSummaries(summary, this.currentSummary) >= 0) {
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
            region1Cost,
            region2Cost,
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

  private findBestRerouteMutation(): RerouteMutation | undefined {
    if (
      this.MAX_HOT_REGIONS === 0 ||
      this.MAX_REROUTE_ROUTES === 0 ||
      this.REROUTE_CONGESTION_FACTORS.length === 0
    ) {
      return
    }

    const hotRegionIds = Array.from(
      { length: this.topology.regionCount },
      (_, regionId) => regionId,
    )
      .filter(
        (regionId) =>
          this.state.regionIntersectionCaches[regionId]!.existingRegionCost >
          COST_EPSILON,
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
        hotRegionIds.flatMap((regionId) =>
          this.state.regionSegments[regionId]!.map(([routeId]) => routeId),
        ),
      ),
    ]
      .map((routeId) => ({
        routeId,
        hotRegionCostContribution: hotRegionIds.reduce(
          (total, regionId) =>
            total +
            this.state.regionIntersectionCaches[regionId]!.existingRegionCost -
            this.computeRegionCostWithoutRoute(regionId, routeId),
          0,
        ),
      }))
      .sort(
        (left, right) =>
          right.hotRegionCostContribution - left.hotRegionCostContribution ||
          left.routeId - right.routeId,
      )
      .slice(0, this.MAX_REROUTE_ROUTES)
      .map(({ routeId }) => routeId)

    let bestMutation: RerouteMutation | undefined
    for (const routeId of routeIds) {
      for (const congestionFactor of this.REROUTE_CONGESTION_FACTORS) {
        const candidateSolver = new SingleRouteReplacementSolver(
          this,
          routeId,
          congestionFactor,
          this.REROUTE_MAX_ITERATIONS,
        )
        candidateSolver.solve()
        this.evaluatedMutationCount += 1
        if (!candidateSolver.solved || candidateSolver.failed) continue

        const candidateRouteSegmentCount = this.getRouteSegmentCount(
          candidateSolver,
          routeId,
        )
        if (
          candidateRouteSegmentCount >
          this.initialRouteSegmentCounts[routeId]! +
            this.MAX_REROUTE_SEGMENT_INCREASE
        ) {
          this.rejectedRerouteDetourCount += 1
          continue
        }

        const summary = this.summarizeSolverState(candidateSolver)
        if (compareRegionCostSummaries(summary, this.currentSummary) >= 0) {
          continue
        }

        const mutation: RerouteMutation = {
          kind: "reroute",
          routeId,
          congestionFactor,
          solver: candidateSolver,
          summary,
        }
        if (
          !bestMutation ||
          compareRegionCostSummaries(summary, bestMutation.summary) < 0 ||
          (compareRegionCostSummaries(summary, bestMutation.summary) === 0 &&
            (routeId < bestMutation.routeId ||
              (routeId === bestMutation.routeId &&
                congestionFactor < bestMutation.congestionFactor)))
        ) {
          bestMutation = mutation
        }
      }
    }

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

  private computeRegionCostWithoutRoute(
    regionId: RegionId,
    removedRouteId: RouteId,
  ): number {
    const netIds: NetId[] = []
    const lesserAngles: number[] = []
    const greaterAngles: number[] = []
    const layerMasks: number[] = []
    let entryExitLayerChanges = 0

    for (const [routeId, fromPortId, toPortId] of this.state.regionSegments[
      regionId
    ]!) {
      if (routeId === removedRouteId) continue
      const geometry = this.populateSegmentGeometryScratch(
        regionId,
        fromPortId,
        toPortId,
      )
      netIds.push(this.problem.routeNet[routeId]!)
      lesserAngles.push(geometry.lesserAngle)
      greaterAngles.push(geometry.greaterAngle)
      layerMasks.push(geometry.layerMask)
      entryExitLayerChanges += geometry.entryExitLayerChanges
    }

    let sameLayerIntersections = 0
    let crossingLayerIntersections = 0
    for (let leftIndex = 0; leftIndex < netIds.length; leftIndex++) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < netIds.length;
        rightIndex++
      ) {
        if (netIds[leftIndex] === netIds[rightIndex]) continue
        const intersects =
          (lesserAngles[rightIndex]! < lesserAngles[leftIndex]! &&
            lesserAngles[leftIndex]! < greaterAngles[rightIndex]!) !==
          (lesserAngles[rightIndex]! < greaterAngles[leftIndex]! &&
            greaterAngles[leftIndex]! < greaterAngles[rightIndex]!)
        if (!intersects) continue

        if ((layerMasks[leftIndex]! & layerMasks[rightIndex]!) !== 0) {
          sameLayerIntersections += 1
        } else {
          crossingLayerIntersections += 1
        }
      }
    }

    return this.computeRegionCostForRegion(
      regionId,
      sameLayerIntersections,
      crossingLayerIntersections,
      entryExitLayerChanges,
      netIds.length,
    )
  }

  private summarizeSolverState(
    solver: TinyHyperGraphSolver,
  ): RegionCostSummary {
    let maxRegionCost = 0
    let totalRegionCost = 0
    for (const cache of solver.state.regionIntersectionCaches) {
      maxRegionCost = Math.max(maxRegionCost, cache.existingRegionCost)
      totalRegionCost += cache.existingRegionCost
    }
    return { maxRegionCost, totalRegionCost }
  }

  private selectBetterMutation(
    swapMutation: SwapMutation | undefined,
    rerouteMutation: RerouteMutation | undefined,
  ): UnravelMutation | undefined {
    if (!swapMutation) return rerouteMutation
    if (!rerouteMutation) return swapMutation
    return compareRegionCostSummaries(
      swapMutation.summary,
      rerouteMutation.summary,
    ) <= 0
      ? swapMutation
      : rerouteMutation
  }

  private computeRegionCostAfterSwap(
    regionId: RegionId,
    left: BoundaryPortSlot,
    right: BoundaryPortSlot,
  ) {
    const netIds: NetId[] = []
    const lesserAngles: number[] = []
    const greaterAngles: number[] = []
    const layerMasks: number[] = []
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
      netIds.push(this.problem.routeNet[routeId]!)
      lesserAngles.push(geometry.lesserAngle)
      greaterAngles.push(geometry.greaterAngle)
      layerMasks.push(geometry.layerMask)
      entryExitLayerChanges += geometry.entryExitLayerChanges
    }

    let sameLayerIntersections = 0
    let crossingLayerIntersections = 0
    for (let leftIndex = 0; leftIndex < netIds.length; leftIndex++) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < netIds.length;
        rightIndex++
      ) {
        if (netIds[leftIndex] === netIds[rightIndex]) continue
        const intersects =
          (lesserAngles[rightIndex]! < lesserAngles[leftIndex]! &&
            lesserAngles[leftIndex]! < greaterAngles[rightIndex]!) !==
          (lesserAngles[rightIndex]! < greaterAngles[leftIndex]! &&
            greaterAngles[leftIndex]! < greaterAngles[rightIndex]!)
        if (!intersects) continue

        if ((layerMasks[leftIndex]! & layerMasks[rightIndex]!) !== 0) {
          sameLayerIntersections += 1
        } else {
          crossingLayerIntersections += 1
        }
      }
    }

    return this.computeRegionCostForRegion(
      regionId,
      sameLayerIntersections,
      crossingLayerIntersections,
      entryExitLayerChanges,
      netIds.length,
    )
  }

  private applySwapMutation(mutation: SwapMutation) {
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
    this.state.portAssignment = new Int32Array(
      mutation.solver.state.portAssignment,
    )
    this.state.regionSegments = mutation.solver.state.regionSegments.map(
      (segments) =>
        segments.map(
          ([routeId, fromPortId, toPortId]) =>
            [routeId, fromPortId, toPortId] as [RouteId, PortId, PortId],
        ),
    )
    this.state.regionIntersectionCaches =
      mutation.solver.state.regionIntersectionCaches.map(
        cloneRegionIntersectionCache,
      )
    this.state.regionCongestionCost.fill(0)
    this.state.currentRouteId = undefined
    this.state.currentRouteNetId = undefined
    this.state.unroutedRoutes = []
    this.state.candidateQueue.clear()
    this.resetCandidateBestCosts()
    this.state.goalPortId = -1
  }

  private rebuildRegionCache(regionId: RegionId) {
    this.state.regionIntersectionCaches[regionId] =
      createEmptyRegionIntersectionCache()
    for (const [routeId, fromPortId, toPortId] of this.state.regionSegments[
      regionId
    ]!) {
      this.state.currentRouteNetId = this.problem.routeNet[routeId]
      this.appendSegmentToRegionCache(regionId, fromPortId, toPortId)
    }
    this.state.currentRouteNetId = undefined
  }

  private finishOptimization(
    reason: "local_optimum" | "mutation_limit" | "target_reached",
  ) {
    this.stats = {
      ...this.stats,
      finalMaxRegionCost: this.currentSummary.maxRegionCost,
      finalTotalRegionCost: this.currentSummary.totalRegionCost,
      acceptedMutationCount: this.acceptedMutationCount,
      evaluatedMutationCount: this.evaluatedMutationCount,
      rejectedRerouteDetourCount: this.rejectedRerouteDetourCount,
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
