import type { TinyHyperGraphProblem, TinyHyperGraphTopology } from "./core"
import { MinHeap } from "./MinHeap"
import type { NetId, PortId, RegionId, RouteId } from "./types"

interface CreateDirectedRouteDistanceHeuristicContext {
  topology: TinyHyperGraphTopology
  problem: TinyHyperGraphProblem
  portEndpointReservationNetId: Int32Array
  portAssignment?: Int32Array
  routeId: RouteId
}

interface RegionDistanceCandidate {
  regionId: RegionId
  distance: number
}

const isRegionAvailableToNet = (
  problem: TinyHyperGraphProblem,
  routeNetId: NetId,
  regionId: RegionId,
) => {
  const reservedNetId = problem.regionNetId[regionId]
  return reservedNetId === -1 || reservedNetId === routeNetId
}

const isPortAvailableToNet = (
  problem: TinyHyperGraphProblem,
  portEndpointReservationNetId: Int32Array,
  portAssignment: Int32Array | undefined,
  routeNetId: NetId,
  portId: PortId,
) => {
  if (problem.portSectionMask[portId] === 0) return false

  const assignedNetId = portAssignment?.[portId] ?? -1
  if (assignedNetId !== -1 && assignedNetId !== routeNetId) return false

  const reservedNetId = portEndpointReservationNetId[portId] ?? -1
  return reservedNetId === -1 || reservedNetId === routeNetId
}

const getDistance = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) => Math.hypot(x2 - x1, y2 - y1)

const getPortX = (topology: TinyHyperGraphTopology, portId: PortId) =>
  topology.portRoutingCostX?.[portId] ?? topology.portX[portId]!

const getPortY = (topology: TinyHyperGraphTopology, portId: PortId) =>
  topology.portRoutingCostY?.[portId] ?? topology.portY[portId]!

/**
 * Estimates the remaining physical travel distance through legal regions.
 * Region centers provide a small routing graph while ports define its edges.
 */
export const createDirectedRouteDistanceHeuristic = ({
  topology,
  problem,
  portEndpointReservationNetId,
  portAssignment,
  routeId,
}: CreateDirectedRouteDistanceHeuristicContext): Float64Array => {
  const routeNetId = problem.routeNet[routeId]!
  const goalPortId = problem.routeEndPort[routeId]!
  const distanceToGoal = new Float64Array(topology.regionCount).fill(
    Number.POSITIVE_INFINITY,
  )
  const queue = new MinHeap<RegionDistanceCandidate>(
    [],
    (left, right) => left.distance - right.distance,
  )

  for (const goalRegionId of topology.incidentPortRegion[goalPortId] ?? []) {
    if (!isRegionAvailableToNet(problem, routeNetId, goalRegionId)) continue

    const distance = getDistance(
      topology.regionCenterX[goalRegionId]!,
      topology.regionCenterY[goalRegionId]!,
      getPortX(topology, goalPortId),
      getPortY(topology, goalPortId),
    )
    if (distance >= distanceToGoal[goalRegionId]!) continue
    distanceToGoal[goalRegionId] = distance
    queue.queue({ regionId: goalRegionId, distance })
  }

  while (queue.length > 0) {
    const current = queue.dequeue()!
    if (current.distance !== distanceToGoal[current.regionId]) continue

    for (const portId of topology.regionIncidentPorts[current.regionId] ?? []) {
      if (
        !isPortAvailableToNet(
          problem,
          portEndpointReservationNetId,
          portAssignment,
          routeNetId,
          portId,
        )
      ) {
        continue
      }

      const incidentRegions = topology.incidentPortRegion[portId] ?? []
      const previousRegionId =
        incidentRegions[0] === current.regionId
          ? incidentRegions[1]
          : incidentRegions[0]
      if (
        previousRegionId === undefined ||
        !isRegionAvailableToNet(problem, routeNetId, previousRegionId)
      ) {
        continue
      }

      const distance =
        current.distance +
        getDistance(
          topology.regionCenterX[current.regionId]!,
          topology.regionCenterY[current.regionId]!,
          getPortX(topology, portId),
          getPortY(topology, portId),
        ) +
        getDistance(
          getPortX(topology, portId),
          getPortY(topology, portId),
          topology.regionCenterX[previousRegionId]!,
          topology.regionCenterY[previousRegionId]!,
        )
      if (distance >= distanceToGoal[previousRegionId]!) continue

      distanceToGoal[previousRegionId] = distance
      queue.queue({ regionId: previousRegionId, distance })
    }
  }

  return distanceToGoal
}

export const getDirectedRouteDistance = (
  topology: TinyHyperGraphTopology,
  distanceToGoal: Float64Array,
  portId: PortId,
  nextRegionId: RegionId,
) =>
  getDistance(
    getPortX(topology, portId),
    getPortY(topology, portId),
    topology.regionCenterX[nextRegionId]!,
    topology.regionCenterY[nextRegionId]!,
  ) + distanceToGoal[nextRegionId]!
