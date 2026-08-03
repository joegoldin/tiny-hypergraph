import {
  type Candidate,
  TinyHyperGraphSolver,
  type TinyHyperGraphProblem,
  type TinyHyperGraphSolverOptions,
  type TinyHyperGraphTopology,
  type TinyHyperGraphWorkingState,
} from "./core"
import { IndexedCandidateHeap } from "./indexed-candidate-heap"
import { MinHeap } from "./MinHeap"
import type { NetId, PortId } from "./types"

type PortDistanceCandidate = {
  portId: PortId
  distance: number
}

/**
 * Adds geometric segment distance to the normal dynamic routing cost.
 *
 * Every segment, including the final segment into the goal, uses the same
 * g-cost calculation. The hop-keyed candidate frontier prevents a dominated
 * queued hop from being expanded later.
 */
export class DistanceAwareTinyHyperGraphSolver extends TinyHyperGraphSolver {
  private readonly graphDistanceToGoalByRouteKey = new Map<
    string,
    Float64Array
  >()

  private graphHeuristicBuildCount = 0

  private graphHeuristicExpandedPortCount = 0

  constructor(
    topology: TinyHyperGraphTopology,
    problem: TinyHyperGraphProblem,
    options?: TinyHyperGraphSolverOptions,
  ) {
    super(topology, problem, options)
  }

  override _setup(): void {
    super._setup()
    this.state.candidateQueue = new IndexedCandidateHeap(
      this.topology.regionCount,
    ) as unknown as TinyHyperGraphWorkingState["candidateQueue"]
  }

  override computeG(
    currentCandidate: Candidate,
    neighborPortId: number,
  ): number {
    const baseCost = super.computeG(currentCandidate, neighborPortId)
    if (!Number.isFinite(baseCost)) return baseCost

    const dx =
      this.getPortRoutingCostX(currentCandidate.portId) -
      this.getPortRoutingCostX(neighborPortId)
    const dy =
      this.getPortRoutingCostY(currentCandidate.portId) -
      this.getPortRoutingCostY(neighborPortId)
    return baseCost + Math.hypot(dx, dy) * this.DISTANCE_TO_COST
  }

  override computeH(neighborPortId: PortId): number {
    const euclideanDistance = super.computeH(neighborPortId)
    const routeId = this.state.currentRouteId
    const routeNetId = this.state.currentRouteNetId
    if (routeId === undefined || routeNetId === undefined) {
      return euclideanDistance
    }

    const goalPortId = this.problem.routeEndPort[routeId]!
    const routeKey = `${routeNetId}:${goalPortId}`
    let graphDistances = this.graphDistanceToGoalByRouteKey.get(routeKey)
    if (graphDistances === undefined) {
      graphDistances = this.computeGraphDistanceToGoal(goalPortId, routeNetId)
      this.graphDistanceToGoalByRouteKey.set(routeKey, graphDistances)
    }
    const graphDistance = graphDistances[neighborPortId]!
    return Number.isFinite(graphDistance)
      ? Math.max(euclideanDistance, graphDistance)
      : euclideanDistance
  }

  private computeGraphDistanceToGoal(
    goalPortId: PortId,
    routeNetId: NetId,
  ): Float64Array {
    const distances = new Float64Array(this.topology.portCount).fill(
      Number.POSITIVE_INFINITY,
    )
    const queue = new MinHeap<PortDistanceCandidate>(
      [],
      (left, right) => left.distance - right.distance,
    )
    distances[goalPortId] = 0
    queue.queue({ portId: goalPortId, distance: 0 })
    let expandedPortCount = 0

    while (queue.length > 0) {
      const current = queue.dequeue()!
      if (current.distance !== distances[current.portId]) continue
      expandedPortCount += 1

      for (const regionId of this.topology.incidentPortRegion[
        current.portId
      ] ?? []) {
        const reservedNetId = this.problem.regionNetId[regionId]!
        if (reservedNetId !== -1 && reservedNetId !== routeNetId) continue

        for (const neighborPortId of this.topology.regionIncidentPorts[
          regionId
        ] ?? []) {
          if (
            neighborPortId === current.portId ||
            (neighborPortId !== goalPortId &&
              this.problem.portSectionMask[neighborPortId] === 0)
          ) {
            continue
          }
          const distance =
            current.distance +
            Math.hypot(
              this.getPortRoutingCostX(current.portId) -
                this.getPortRoutingCostX(neighborPortId),
              this.getPortRoutingCostY(current.portId) -
                this.getPortRoutingCostY(neighborPortId),
            ) *
              this.DISTANCE_TO_COST
          if (distance >= distances[neighborPortId]!) continue
          distances[neighborPortId] = distance
          queue.queue({ portId: neighborPortId, distance })
        }
      }
    }

    this.graphHeuristicBuildCount += 1
    this.graphHeuristicExpandedPortCount += expandedPortCount
    this.stats = {
      ...this.stats,
      graphHeuristicBuildCount: this.graphHeuristicBuildCount,
      graphHeuristicExpandedPortCount: this.graphHeuristicExpandedPortCount,
    }
    return distances
  }
}
