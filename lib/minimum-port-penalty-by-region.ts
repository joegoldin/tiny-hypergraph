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
  portAssignment: Int32Array
  portReservationNetId: Int32Array
  regionCongestionCost: Float64Array
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

const isPortBlocked = ({
  portId,
  routeNetId,
  portAssignment,
  portReservationNetId,
}: {
  portId: PortId
  routeNetId: NetId
  portAssignment: Int32Array
  portReservationNetId: Int32Array
}): boolean => {
  const assignedNetId = portAssignment[portId] ?? -1
  const reservedNetId = portReservationNetId[portId] ?? -1
  return (
    (assignedNetId !== -1 && assignedNetId !== routeNetId) ||
    reservedNetId === -2 ||
    (reservedNetId !== -1 && reservedNetId !== routeNetId)
  )
}

/**
 * Computes the minimum unavoidable port and congestion cost from each region
 * to the goal. It ignores segment geometry, so it remains a lower bound.
 */
export const getMinimumPortPenaltyByRegion = ({
  topology,
  problem,
  routeNetId,
  goalPortId,
  portAssignment,
  portReservationNetId,
  regionCongestionCost,
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
      if (
        problem.portSectionMask[portId] === 0 ||
        isPortBlocked({
          portId,
          routeNetId,
          portAssignment,
          portReservationNetId,
        })
      ) {
        continue
      }
      for (const neighborRegionId of topology.incidentPortRegion[portId]) {
        const nextCost =
          candidate.cost +
          (problem.portPenalty?.[portId] ?? 0) +
          regionCongestionCost[neighborRegionId]
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
