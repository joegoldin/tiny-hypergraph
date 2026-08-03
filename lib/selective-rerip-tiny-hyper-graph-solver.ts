import {
  type Candidate,
  createEmptyRegionIntersectionCache,
  type TinyHyperGraphProblem,
  type TinyHyperGraphSolverOptions,
  type TinyHyperGraphTopology,
} from "./core"
import { DistanceAwareTinyHyperGraphSolver } from "./distance-aware-tiny-hypergraph-solver"
import {
  findDistinctOwnerBlockerPath,
  type DistinctOwnerBlockerSearchResult,
} from "./find-distinct-owner-blocker-path"
import type { PortId, RegionId, RouteId } from "./types"

type RelaxedSearchState = {
  portId: PortId
  nextRegionId: RegionId
}

type PortBlockerResource = {
  kind: "port"
  portId: PortId
  owners: RouteId[]
}

type SameLayerIntersectionBlockerResource = {
  kind: "same_layer_intersection"
  regionId: RegionId
  fromPortId: PortId
  toPortId: PortId
  owners: RouteId[]
}

export type SelectiveReripBlockerResource =
  | PortBlockerResource
  | SameLayerIntersectionBlockerResource

type RelaxedSearchHopData = {
  resources: SelectiveReripBlockerResource[]
}

type RelaxedBlockerPathResult = DistinctOwnerBlockerSearchResult<
  RelaxedSearchState,
  RouteId,
  RelaxedSearchHopData
>

type RelaxedBlockerPathSuccess = Extract<
  RelaxedBlockerPathResult,
  { found: true }
>

const MAX_SELECTIVE_RERIP_CONGESTION_UPDATES = 1

export type FailedOwnerPairCount = {
  failedRouteId: RouteId
  ownerRouteId: RouteId
  count: number
}

export type SelectiveReripTinyHyperGraphStats = {
  selectiveRipCount: number
  selectivelyRippedRouteCount: number
  globalReripCount: number
  globalReripReason?: "no_path" | "expansion_limit" | "no_blocker_path"
  alternateBlockerSearchCount: number
  alternateOwnerCount: number
  failedOwnerPairCount: number
  maxFailedOwnerPairCount: number
  failedOwnerPairs: FailedOwnerPairCount[]
  lastFailedRouteId?: RouteId
  lastDirectOwnerRouteIds: RouteId[]
  lastRepeatedOwnerRouteIds: RouteId[]
  lastAlternateOwnerRouteIds: RouteId[]
  lastRippedRouteIds: RouteId[]
  lastRelaxedSearchExpandedLabelCount: number
  lastAlternateSearchExpandedLabelCount: number
}

const createInitialSelectiveReripStats =
  (): SelectiveReripTinyHyperGraphStats => ({
    selectiveRipCount: 0,
    selectivelyRippedRouteCount: 0,
    globalReripCount: 0,
    alternateBlockerSearchCount: 0,
    alternateOwnerCount: 0,
    failedOwnerPairCount: 0,
    maxFailedOwnerPairCount: 0,
    failedOwnerPairs: [],
    lastDirectOwnerRouteIds: [],
    lastRepeatedOwnerRouteIds: [],
    lastAlternateOwnerRouteIds: [],
    lastRippedRouteIds: [],
    lastRelaxedSearchExpandedLabelCount: 0,
    lastAlternateSearchExpandedLabelCount: 0,
  })

export function orderConnectionsByNetCardinality<TConnection>(
  connections: readonly TConnection[],
  getNetId: (connection: TConnection) => string | number,
): TConnection[] {
  const connectionCountByNetId = new Map<string | number, number>()
  for (const connection of connections) {
    const netId = getNetId(connection)
    connectionCountByNetId.set(
      netId,
      (connectionCountByNetId.get(netId) ?? 0) + 1,
    )
  }

  return connections
    .map((connection, index) => ({ connection, index }))
    .sort(
      (left, right) =>
        (connectionCountByNetId.get(getNetId(right.connection)) ?? 0) -
          (connectionCountByNetId.get(getNetId(left.connection)) ?? 0) ||
        left.index - right.index,
    )
    .map(({ connection }) => connection)
}

export function selectOwnerRouteIdsToRip(params: {
  failedRouteId: RouteId
  directOwnerRouteIds: readonly RouteId[]
  alternateOwnerRouteIds?: readonly RouteId[]
}): Set<RouteId> {
  const rippedRouteIds = new Set<RouteId>(
    params.alternateOwnerRouteIds ?? params.directOwnerRouteIds,
  )
  rippedRouteIds.delete(params.failedRouteId)
  if (rippedRouteIds.size === 0) {
    throw new Error(
      `SelectiveReripTinyHyperGraphSolver: route ${params.failedRouteId} has blocker resources but no distinct committed owner can be reripped`,
    )
  }

  return rippedRouteIds
}

export function orderRoutesAfterSelectiveRerip(params: {
  failedRouteId: RouteId
  pendingRouteIds: readonly RouteId[]
  rippedRouteIds: ReadonlySet<RouteId>
}): RouteId[] {
  const pendingRouteIds = params.pendingRouteIds.filter(
    (routeId) =>
      routeId !== params.failedRouteId && !params.rippedRouteIds.has(routeId),
  )
  const rippedRouteIds = [...params.rippedRouteIds].filter(
    (routeId) => routeId !== params.failedRouteId,
  )

  return [params.failedRouteId, ...pendingRouteIds, ...rippedRouteIds]
}

/**
 * Keeps the normal tiny-hypergraph route acceptance policy while replacing a
 * full rerip with a minimal, explicit rerip when the exhausted route has a
 * known set of committed blockers.
 */
export class SelectiveReripTinyHyperGraphSolver extends DistanceAwareTinyHyperGraphSolver {
  private readonly failedOwnerPairCounts = new Map<
    RouteId,
    Map<RouteId, number>
  >()

  private readonly selectiveReripStats = createInitialSelectiveReripStats()

  private selectiveReripCongestionUpdateCount = 0

  private readonly displacedRouteIdsPendingRetry = new Set<RouteId>()

  private committedBlockerPathCount = 0

  constructor(
    topology: TinyHyperGraphTopology,
    problem: TinyHyperGraphProblem,
    options?: TinyHyperGraphSolverOptions,
  ) {
    super(topology, problem, options)
  }

  getSelectiveReripStats(): SelectiveReripTinyHyperGraphStats {
    return {
      ...this.selectiveReripStats,
      failedOwnerPairs: this.selectiveReripStats.failedOwnerPairs.map(
        (pair) => ({
          ...pair,
        }),
      ),
      lastDirectOwnerRouteIds: [
        ...this.selectiveReripStats.lastDirectOwnerRouteIds,
      ],
      lastRepeatedOwnerRouteIds: [
        ...this.selectiveReripStats.lastRepeatedOwnerRouteIds,
      ],
      lastAlternateOwnerRouteIds: [
        ...this.selectiveReripStats.lastAlternateOwnerRouteIds,
      ],
      lastRippedRouteIds: [...this.selectiveReripStats.lastRippedRouteIds],
    }
  }

  /**
   * A selectively ripped route already had a valid path before another route
   * displaced it. Check whether that displacement still blocks every path
   * before repeating the full constrained search.
   */
  override _step(): void {
    const nextRouteId = this.state.unroutedRoutes[0]
    const retryRouteId =
      this.state.currentRouteId === undefined &&
      nextRouteId !== undefined &&
      this.displacedRouteIdsPendingRetry.has(nextRouteId)
        ? nextRouteId
        : undefined

    super._step()

    if (retryRouteId !== undefined) {
      this.displacedRouteIdsPendingRetry.delete(retryRouteId)
    }
    if (
      retryRouteId === undefined ||
      this.state.currentRouteId !== retryRouteId ||
      this.routeSuccessCountByRouteId[retryRouteId]! === 0
    ) {
      return
    }

    const directPath = this.findRelaxedBlockerPath()
    if (!directPath.found || directPath.owners.size === 0) {
      return
    }

    this.handleBlockedRoute(directPath)
  }

  override onOutOfCandidates(): void {
    this.handleBlockedRoute(this.findRelaxedBlockerPath())
  }

  private handleBlockedRoute(directPath: RelaxedBlockerPathResult): void {
    const failedRouteId = this.state.currentRouteId
    if (failedRouteId === undefined) {
      throw new Error(
        "SelectiveReripTinyHyperGraphSolver: candidate search exhausted without a current route",
      )
    }

    if (!directPath.found || directPath.owners.size === 0) {
      this.displacedRouteIdsPendingRetry.clear()
      this.selectiveReripStats.globalReripCount += 1
      this.selectiveReripStats.globalReripReason = !directPath.found
        ? directPath.reason
        : "no_blocker_path"
      this.selectiveReripStats.lastFailedRouteId = failedRouteId
      this.selectiveReripStats.lastDirectOwnerRouteIds = []
      this.selectiveReripStats.lastRepeatedOwnerRouteIds = []
      this.selectiveReripStats.lastAlternateOwnerRouteIds = []
      this.selectiveReripStats.lastRippedRouteIds = []
      this.selectiveReripStats.lastRelaxedSearchExpandedLabelCount =
        directPath.expandedLabelCount
      this.selectiveReripStats.lastAlternateSearchExpandedLabelCount = 0
      super.onOutOfCandidates()
      this.publishSelectiveReripStats()
      return
    }

    const directOwnerRouteIds = [...directPath.owners]
    const repeatedOwnerRouteIds: RouteId[] = []
    for (const ownerRouteId of directOwnerRouteIds) {
      const count = this.incrementFailedOwnerPair(failedRouteId, ownerRouteId)
      if (count >= 2) repeatedOwnerRouteIds.push(ownerRouteId)
    }

    let alternatePath:
      | DistinctOwnerBlockerSearchResult<
          RelaxedSearchState,
          RouteId,
          RelaxedSearchHopData
        >
      | undefined
    if (repeatedOwnerRouteIds.length > 0) {
      this.selectiveReripStats.alternateBlockerSearchCount += 1
      alternatePath = this.findRelaxedBlockerPath(
        new Set(repeatedOwnerRouteIds),
      )
      if (!alternatePath.found) {
        this.selectiveReripStats.globalReripCount += 1
        this.selectiveReripStats.globalReripReason = alternatePath.reason
        this.selectiveReripStats.lastFailedRouteId = failedRouteId
        this.selectiveReripStats.lastDirectOwnerRouteIds = directOwnerRouteIds
        this.selectiveReripStats.lastRepeatedOwnerRouteIds =
          repeatedOwnerRouteIds
        this.selectiveReripStats.lastAlternateOwnerRouteIds = []
        this.selectiveReripStats.lastRippedRouteIds = []
        this.selectiveReripStats.lastRelaxedSearchExpandedLabelCount =
          directPath.expandedLabelCount
        this.selectiveReripStats.lastAlternateSearchExpandedLabelCount =
          alternatePath.expandedLabelCount
        super.onOutOfCandidates()
        this.publishSelectiveReripStats()
        return
      }
    }

    const alternateOwnerRouteIds = alternatePath?.found
      ? [...alternatePath.owners]
      : undefined
    const rippedRouteIds = selectOwnerRouteIdsToRip({
      failedRouteId,
      directOwnerRouteIds,
      alternateOwnerRouteIds,
    })
    const alternateOnlyOwnerRouteIds = (alternateOwnerRouteIds ?? []).filter(
      (ownerRouteId) => !directPath.owners.has(ownerRouteId),
    )
    if (
      this.selectiveReripCongestionUpdateCount <
      MAX_SELECTIVE_RERIP_CONGESTION_UPDATES
    ) {
      this.addCongestionCostForSelectiveRerip()
      this.selectiveReripCongestionUpdateCount += 1
    }
    for (const rippedRouteId of rippedRouteIds) {
      this.displacedRouteIdsPendingRetry.add(rippedRouteId)
    }
    this.rebuildCommittedState(rippedRouteIds)
    const committedBlockerPath = this.tryCommitBlockerPath(
      failedRouteId,
      alternatePath?.found ? alternatePath : directPath,
    )
    this.state.ripCount += 1
    this.state.unroutedRoutes = orderRoutesAfterSelectiveRerip({
      failedRouteId,
      pendingRouteIds: this.state.unroutedRoutes,
      rippedRouteIds,
    }).filter((routeId) => !committedBlockerPath || routeId !== failedRouteId)
    if (!committedBlockerPath) {
      this.state.currentRouteId = undefined
      this.state.currentRouteNetId = undefined
    }
    this.state.candidateQueue.clear()
    this.resetCandidateBestCosts()
    this.state.goalPortId = -1

    this.selectiveReripStats.selectiveRipCount += 1
    this.selectiveReripStats.selectivelyRippedRouteCount += rippedRouteIds.size
    this.selectiveReripStats.alternateOwnerCount +=
      alternateOnlyOwnerRouteIds.length
    this.selectiveReripStats.lastFailedRouteId = failedRouteId
    this.selectiveReripStats.lastDirectOwnerRouteIds = directOwnerRouteIds
    this.selectiveReripStats.lastRepeatedOwnerRouteIds = repeatedOwnerRouteIds
    this.selectiveReripStats.lastAlternateOwnerRouteIds =
      alternateOnlyOwnerRouteIds
    this.selectiveReripStats.lastRippedRouteIds = [...rippedRouteIds]
    this.selectiveReripStats.lastRelaxedSearchExpandedLabelCount =
      directPath.expandedLabelCount
    this.selectiveReripStats.lastAlternateSearchExpandedLabelCount =
      alternatePath?.expandedLabelCount ?? 0
    this.publishSelectiveReripStats()
  }

  private tryCommitBlockerPath(
    routeId: RouteId,
    blockerPath: RelaxedBlockerPathSuccess,
  ): boolean {
    if (
      this.state.currentRouteId !== routeId ||
      this.state.currentRouteNetId === undefined
    ) {
      return false
    }

    const startState = blockerPath.states[0]
    if (
      startState === undefined ||
      startState.portId !== this.problem.routeStartPort[routeId]
    ) {
      return false
    }

    const routeNetId = this.state.currentRouteNetId
    const goalPortId = this.problem.routeEndPort[routeId]!
    const portOwners = this.getPortOwners()
    let finalCandidate: Candidate = {
      portId: startState.portId,
      nextRegionId: startState.nextRegionId,
      f: 0,
      g: 0,
      h: 0,
    }

    for (
      let stateIndex = 1;
      stateIndex < blockerPath.states.length;
      stateIndex++
    ) {
      const previousState = blockerPath.states[stateIndex - 1]!
      const state = blockerPath.states[stateIndex]!
      if (
        previousState.portId !== finalCandidate.portId ||
        previousState.nextRegionId !== finalCandidate.nextRegionId ||
        this.isRegionReservedForDifferentNet(previousState.nextRegionId) ||
        this.isPortReservedForDifferentNet(state.portId) ||
        (state.portId !== goalPortId &&
          this.problem.portSectionMask[state.portId] === 0)
      ) {
        return false
      }

      const blockerResources = this.getHopBlockerResources({
        regionId: previousState.nextRegionId,
        fromPortId: previousState.portId,
        toPortId: state.portId,
        routeNetId,
        portOwners,
      })
      if (blockerResources.length > 0) return false

      const g = this.computeG(finalCandidate, state.portId)
      if (!Number.isFinite(g)) return false

      const h = state.portId === goalPortId ? 0 : this.computeH(state.portId)
      finalCandidate = {
        prevRegionId: previousState.nextRegionId,
        nextRegionId: state.nextRegionId,
        portId: state.portId,
        f: g + h,
        g,
        h,
        prevCandidate: finalCandidate,
      }
    }

    if (finalCandidate.portId !== goalPortId) return false
    this.onPathFound(finalCandidate)
    this.committedBlockerPathCount++
    this.stats = {
      ...this.stats,
      committedBlockerPathCount: this.committedBlockerPathCount,
    }
    return true
  }

  private addCongestionCostForSelectiveRerip(): void {
    for (let regionId = 0; regionId < this.topology.regionCount; regionId++) {
      const regionCost =
        this.state.regionIntersectionCaches[regionId]?.existingRegionCost ?? 0
      this.state.regionCongestionCost[regionId] +=
        regionCost * this.RIP_CONGESTION_REGION_COST_FACTOR
    }
  }

  protected findRelaxedBlockerPath(
    forbiddenOwnerRouteIds: ReadonlySet<RouteId> = new Set<RouteId>(),
  ): RelaxedBlockerPathResult {
    const routeId = this.state.currentRouteId
    const routeNetId = this.state.currentRouteNetId
    if (routeId === undefined || routeNetId === undefined) {
      throw new Error(
        "SelectiveReripTinyHyperGraphSolver: blocker search requires a current route and net",
      )
    }

    const startPortId = this.problem.routeStartPort[routeId]!
    const goalPortId = this.problem.routeEndPort[routeId]!
    const startRegionId = this.getStartingNextRegionId(routeId, startPortId)
    if (startRegionId === undefined) {
      throw new Error(
        `SelectiveReripTinyHyperGraphSolver: route ${this.describeRoute(routeId)} has no starting region for blocker search`,
      )
    }

    const portOwners = this.getPortOwners()
    return findDistinctOwnerBlockerPath({
      start: { portId: startPortId, nextRegionId: startRegionId },
      getStateKey: ({ portId, nextRegionId }): number =>
        this.getHopId(portId, nextRegionId),
      isGoal: ({ portId }): boolean => portId === goalPortId,
      getHops: (state) =>
        this.getRelaxedSearchHops({
          state,
          goalPortId,
          routeNetId,
          portOwners,
          forbiddenOwnerRouteIds,
        }),
      maxExpandedLabels: this.getRelaxedSearchExpansionLimit(),
    })
  }

  protected getRelaxedSearchExpansionLimit(): number {
    let incidentHopCount = 0
    for (const incidentRegions of this.topology.incidentPortRegion) {
      incidentHopCount += incidentRegions.length
    }
    const ownerScale = Math.max(
      4,
      Math.ceil(Math.log2(this.problem.routeCount + 1)),
    )
    return Math.max(4096, incidentHopCount * ownerScale * 4)
  }

  private getRelaxedSearchHops(params: {
    state: RelaxedSearchState
    goalPortId: PortId
    routeNetId: number
    portOwners: ReadonlyMap<PortId, ReadonlySet<RouteId>>
    forbiddenOwnerRouteIds: ReadonlySet<RouteId>
  }): Array<{
    state: RelaxedSearchState
    distance: number
    owners: RouteId[]
    data: RelaxedSearchHopData
  }> {
    const { state, goalPortId, routeNetId } = params
    if (this.isRegionReservedForDifferentNet(state.nextRegionId)) return []

    const hops: Array<{
      state: RelaxedSearchState
      distance: number
      owners: RouteId[]
      data: RelaxedSearchHopData
    }> = []
    for (const neighborPortId of this.topology.regionIncidentPorts[
      state.nextRegionId
    ] ?? []) {
      if (neighborPortId === state.portId) continue
      if (this.isPortReservedForDifferentNet(neighborPortId)) continue
      if (
        neighborPortId !== goalPortId &&
        this.problem.portSectionMask[neighborPortId] === 0
      ) {
        continue
      }

      const resources = this.getHopBlockerResources({
        regionId: state.nextRegionId,
        fromPortId: state.portId,
        toPortId: neighborPortId,
        routeNetId,
        portOwners: params.portOwners,
      })
      const owners = [
        ...new Set(resources.flatMap((resource) => resource.owners)),
      ]
      if (
        owners.some((ownerRouteId) =>
          params.forbiddenOwnerRouteIds.has(ownerRouteId),
        )
      ) {
        continue
      }

      let nextRegionId = state.nextRegionId
      if (neighborPortId !== goalPortId) {
        const [firstRegionId, secondRegionId] =
          this.topology.incidentPortRegion[neighborPortId] ?? []
        nextRegionId =
          firstRegionId === state.nextRegionId ? secondRegionId : firstRegionId
        if (
          nextRegionId === undefined ||
          this.isRegionReservedForDifferentNet(nextRegionId)
        ) {
          continue
        }
      }

      hops.push({
        state: { portId: neighborPortId, nextRegionId },
        distance: Math.hypot(
          this.getPortRoutingCostX(state.portId) -
            this.getPortRoutingCostX(neighborPortId),
          this.getPortRoutingCostY(state.portId) -
            this.getPortRoutingCostY(neighborPortId),
        ),
        owners,
        data: { resources },
      })
    }

    return hops
  }

  private getHopBlockerResources(params: {
    regionId: RegionId
    fromPortId: PortId
    toPortId: PortId
    routeNetId: number
    portOwners: ReadonlyMap<PortId, ReadonlySet<RouteId>>
  }): SelectiveReripBlockerResource[] {
    const resources: SelectiveReripBlockerResource[] = []
    const assignedNetId = this.state.portAssignment[params.toPortId]!
    if (assignedNetId !== -1 && assignedNetId !== params.routeNetId) {
      const owners = [
        ...(params.portOwners.get(params.toPortId) ?? new Set<RouteId>()),
      ].filter(
        (routeId) => this.problem.routeNet[routeId] !== params.routeNetId,
      )
      if (owners.length === 0) {
        throw new Error(
          `SelectiveReripTinyHyperGraphSolver: port ${params.toPortId} is assigned to foreign net ${assignedNetId} without a committed route owner`,
        )
      }
      resources.push({ kind: "port", portId: params.toPortId, owners })
    }

    const sameLayerIntersectionOwners = this.getHardBlockedCrossingOwners(
      params.regionId,
      params.fromPortId,
      params.toPortId,
    )
    if (sameLayerIntersectionOwners.length > 0) {
      resources.push({
        kind: "same_layer_intersection",
        regionId: params.regionId,
        fromPortId: params.fromPortId,
        toPortId: params.toPortId,
        owners: sameLayerIntersectionOwners,
      })
    }

    return resources
  }

  private getPortOwners(): Map<PortId, Set<RouteId>> {
    const ownersByPort = new Map<PortId, Set<RouteId>>()
    for (const segments of this.state.regionSegments) {
      for (const [routeId, fromPortId, toPortId] of segments) {
        for (const portId of [fromPortId, toPortId]) {
          const owners = ownersByPort.get(portId) ?? new Set<RouteId>()
          owners.add(routeId)
          ownersByPort.set(portId, owners)
        }
      }
    }

    return ownersByPort
  }

  private getHardBlockedCrossingOwners(
    regionId: RegionId,
    fromPortId: PortId,
    toPortId: PortId,
  ): RouteId[] {
    if (!this.isKnownSingleLayerRegion(regionId)) return []

    const routeNetId = this.state.currentRouteNetId
    if (routeNetId === undefined) {
      throw new Error(
        "SelectiveReripTinyHyperGraphSolver: crossing ownership requires a current route net",
      )
    }
    const owners = new Set<RouteId>()
    for (const [ownerRouteId, ownerFromPortId, ownerToPortId] of this.state
      .regionSegments[regionId] ?? []) {
      if (this.problem.routeNet[ownerRouteId] === routeNetId) continue
      if (
        this.segmentsCrossOnSameLayer(
          regionId,
          fromPortId,
          toPortId,
          ownerFromPortId,
          ownerToPortId,
        )
      ) {
        owners.add(ownerRouteId)
      }
    }

    return [...owners]
  }

  private segmentsCrossOnSameLayer(
    regionId: RegionId,
    firstFromPortId: PortId,
    firstToPortId: PortId,
    secondFromPortId: PortId,
    secondToPortId: PortId,
  ): boolean {
    const first = {
      ...this.populateSegmentGeometryScratch(
        regionId,
        firstFromPortId,
        firstToPortId,
      ),
    }
    const second = {
      ...this.populateSegmentGeometryScratch(
        regionId,
        secondFromPortId,
        secondToPortId,
      ),
    }
    if ((first.layerMask & second.layerMask) === 0) return false
    if (
      first.lesserAngle === second.lesserAngle ||
      first.lesserAngle === second.greaterAngle ||
      first.greaterAngle === second.lesserAngle ||
      first.greaterAngle === second.greaterAngle
    ) {
      return false
    }

    const secondLesserInsideFirst =
      first.lesserAngle < second.lesserAngle &&
      second.lesserAngle < first.greaterAngle
    const secondGreaterInsideFirst =
      first.lesserAngle < second.greaterAngle &&
      second.greaterAngle < first.greaterAngle
    return secondLesserInsideFirst !== secondGreaterInsideFirst
  }

  private rebuildCommittedState(rippedRouteIds: ReadonlySet<RouteId>): void {
    this.state.regionSegments = this.state.regionSegments.map((segments) =>
      segments.filter(([routeId]) => !rippedRouteIds.has(routeId)),
    )
    this.state.portAssignment.fill(-1)
    this.state.regionIntersectionCaches = Array.from(
      { length: this.topology.regionCount },
      () => createEmptyRegionIntersectionCache(),
    )

    for (
      let regionId = 0;
      regionId < this.state.regionSegments.length;
      regionId++
    ) {
      for (const [routeId, fromPortId, toPortId] of this.state.regionSegments[
        regionId
      ]!) {
        const routeNetId = this.problem.routeNet[routeId]!
        this.state.currentRouteNetId = routeNetId
        for (const portId of [fromPortId, toPortId]) {
          const assignedNetId = this.state.portAssignment[portId]!
          if (assignedNetId !== -1 && assignedNetId !== routeNetId) {
            throw new Error(
              `SelectiveReripTinyHyperGraphSolver: rebuilding committed routes found cross-net ownership at port ${portId} between net ${assignedNetId} and net ${routeNetId}`,
            )
          }
          this.state.portAssignment[portId] = routeNetId
        }
        this.appendSegmentToRegionCache(regionId, fromPortId, toPortId)
      }
    }
    this.state.currentRouteNetId = undefined
  }

  private incrementFailedOwnerPair(
    failedRouteId: RouteId,
    ownerRouteId: RouteId,
  ): number {
    const ownerCounts =
      this.failedOwnerPairCounts.get(failedRouteId) ??
      new Map<RouteId, number>()
    const count = (ownerCounts.get(ownerRouteId) ?? 0) + 1
    ownerCounts.set(ownerRouteId, count)
    this.failedOwnerPairCounts.set(failedRouteId, ownerCounts)
    return count
  }

  private publishSelectiveReripStats(): void {
    const failedOwnerPairs: FailedOwnerPairCount[] = []
    for (const [failedRouteId, ownerCounts] of this.failedOwnerPairCounts) {
      for (const [ownerRouteId, count] of ownerCounts) {
        failedOwnerPairs.push({ failedRouteId, ownerRouteId, count })
      }
    }
    failedOwnerPairs.sort(
      (left, right) =>
        left.failedRouteId - right.failedRouteId ||
        left.ownerRouteId - right.ownerRouteId,
    )
    this.selectiveReripStats.failedOwnerPairs = failedOwnerPairs
    this.selectiveReripStats.failedOwnerPairCount = failedOwnerPairs.length
    this.selectiveReripStats.maxFailedOwnerPairCount = Math.max(
      0,
      ...failedOwnerPairs.map(({ count }) => count),
    )
    this.stats = { ...this.stats, ...this.getSelectiveReripStats() }
  }

  private describeRoute(routeId: RouteId): string {
    const connectionId = this.problem.routeMetadata?.[routeId]?.connectionId
    return connectionId === undefined
      ? String(routeId)
      : `${routeId} (${String(connectionId)})`
  }
}
