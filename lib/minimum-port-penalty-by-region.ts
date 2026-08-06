import type { TinyHyperGraphProblem, TinyHyperGraphTopology } from "./core"
import { MinHeap } from "./MinHeap"
import type { NetId, PortId, RegionId } from "./types"

type RegionPenaltyCandidate = {
  regionId: RegionId
  cost: number
}

type MinimumPortPenaltyParams = {
  topology: TinyHyperGraphTopology
  problem: TinyHyperGraphProblem
  routeNetId: NetId
  goalPortId: PortId
}

const compareCandidatesByCost = (
  left: RegionPenaltyCandidate,
  right: RegionPenaltyCandidate,
): number => left.cost - right.cost

const isRegionBlocked = ({
  problem,
  routeNetId,
  regionId,
}: {
  problem: TinyHyperGraphProblem
  routeNetId: NetId
  regionId: RegionId
}): boolean => {
  const regionNetId = problem.regionNetId[regionId]
  return regionNetId !== -1 && regionNetId !== routeNetId
}

/**
 * Computes the minimum remaining fallback-port cost from each region to the
 * goal. This is a lower bound because it ignores congestion and port ownership.
 */
export const getMinimumPortPenaltyByRegion = ({
  topology,
  problem,
  routeNetId,
  goalPortId,
}: MinimumPortPenaltyParams): Float64Array => {
  const costs = new Float64Array(topology.regionCount).fill(
    Number.POSITIVE_INFINITY,
  )
  const candidates = new MinHeap<RegionPenaltyCandidate>(
    [],
    compareCandidatesByCost,
  )

  for (const regionId of topology.incidentPortRegion[goalPortId] ?? []) {
    if (isRegionBlocked({ problem, routeNetId, regionId })) continue
    costs[regionId] = 0
    candidates.queue({ regionId, cost: 0 })
  }

  while (candidates.length > 0) {
    const candidate = candidates.dequeue()!
    if (candidate.cost !== costs[candidate.regionId]) continue

    for (const portId of topology.regionIncidentPorts[candidate.regionId]) {
      if (problem.portSectionMask[portId] === 0) continue
      const nextCost = candidate.cost + (problem.portPenalty?.[portId] ?? 0)

      for (const neighborRegionId of topology.incidentPortRegion[portId]) {
        if (
          neighborRegionId === candidate.regionId ||
          isRegionBlocked({
            problem,
            routeNetId,
            regionId: neighborRegionId,
          }) ||
          nextCost >= costs[neighborRegionId]
        ) {
          continue
        }
        costs[neighborRegionId] = nextCost
        candidates.queue({ regionId: neighborRegionId, cost: nextCost })
      }
    }
  }

  return costs
}

export const getMinimumPortPenalty = (
  costs: Float64Array,
  regionId: RegionId,
): number => {
  const cost = costs[regionId]
  return Number.isFinite(cost) ? cost : 0
}
