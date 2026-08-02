import type { TinyHyperGraphProblem, TinyHyperGraphTopology } from "./core"
import { computeRegionCost } from "./computeRegionCost"
import type { PortId, RegionId, RouteId } from "./types"

export interface LayerAwareRouteHeuristic {
  layerTransitionRegionIdByRoute: Int32Array
  layerTransitionCostByRoute: Float64Array
}

interface CreateLayerAwareRouteHeuristicContext {
  topology: TinyHyperGraphTopology
  problem: TinyHyperGraphProblem
  distanceToCost: number
  minViaPadDiameter: number
}

interface GetLayerAwarePortHeuristicCostContext {
  topology: TinyHyperGraphTopology
  problem: TinyHyperGraphProblem
  layerAwareRouteHeuristic: LayerAwareRouteHeuristic
  distanceToCost: number
  routeId: RouteId
  portId: PortId
}

const getPortRoutingCostX = (
  topology: TinyHyperGraphTopology,
  portId: PortId,
) => topology.portRoutingCostX?.[portId] ?? topology.portX[portId]!

const getPortRoutingCostY = (
  topology: TinyHyperGraphTopology,
  portId: PortId,
) => topology.portRoutingCostY?.[portId] ?? topology.portY[portId]!

const getRegionPortLayerMask = (
  topology: TinyHyperGraphTopology,
  regionId: RegionId,
) => {
  let layerMask = 0

  for (const portId of topology.regionIncidentPorts[regionId] ?? []) {
    layerMask |= 1 << topology.portZ[portId]!
  }

  return layerMask
}

const getTraversableRegionLayerMask = (
  topology: TinyHyperGraphTopology,
  regionId: RegionId,
) => {
  const portLayerMask = getRegionPortLayerMask(topology, regionId)
  const availableLayerMask = topology.regionAvailableZMask?.[regionId] ?? 0

  return availableLayerMask === 0
    ? portLayerMask
    : portLayerMask & availableLayerMask
}

/**
 * Selects one existing ordinary region per cross-layer route. The region must
 * expose ports on both endpoint layers, and the score includes its normal via
 * cost. This changes search order only; it does not change topology or routing
 * legality.
 */
export const createLayerAwareRouteHeuristic = ({
  topology,
  problem,
  distanceToCost,
  minViaPadDiameter,
}: CreateLayerAwareRouteHeuristicContext): LayerAwareRouteHeuristic => {
  const layerTransitionRegionIdByRoute = new Int32Array(
    problem.routeCount,
  ).fill(-1)
  const layerTransitionCostByRoute = new Float64Array(problem.routeCount)
  const traversableLayerMaskByRegion = new Int32Array(topology.regionCount)
  const layerTransitionCostByRegion = new Float64Array(topology.regionCount)

  for (let regionId = 0; regionId < topology.regionCount; regionId++) {
    const traversableLayerMask = getTraversableRegionLayerMask(
      topology,
      regionId,
    )
    traversableLayerMaskByRegion[regionId] = traversableLayerMask
    layerTransitionCostByRegion[regionId] = computeRegionCost(
      topology.regionWidth[regionId]!,
      topology.regionHeight[regionId]!,
      0,
      0,
      1,
      1,
      traversableLayerMask,
      minViaPadDiameter,
    )
  }

  for (let routeId = 0; routeId < problem.routeCount; routeId++) {
    const startPortId = problem.routeStartPort[routeId]!
    const endPortId = problem.routeEndPort[routeId]!
    const startLayer = topology.portZ[startPortId]!
    const endLayer = topology.portZ[endPortId]!

    if (startLayer === endLayer) continue

    const requiredLayerMask = (1 << startLayer) | (1 << endLayer)
    const routeNetId = problem.routeNet[routeId]!
    const startX = getPortRoutingCostX(topology, startPortId)
    const startY = getPortRoutingCostY(topology, startPortId)
    const endX = getPortRoutingCostX(topology, endPortId)
    const endY = getPortRoutingCostY(topology, endPortId)
    let bestTransitionScore = Number.POSITIVE_INFINITY

    for (let regionId = 0; regionId < topology.regionCount; regionId++) {
      if (
        (traversableLayerMaskByRegion[regionId]! & requiredLayerMask) !==
        requiredLayerMask
      ) {
        continue
      }

      const reservedNetId = problem.regionNetId[regionId]!
      if (reservedNetId !== -1 && reservedNetId !== routeNetId) continue

      const transitionX = topology.regionCenterX[regionId]!
      const transitionY = topology.regionCenterY[regionId]!
      const layerTransitionCost = layerTransitionCostByRegion[regionId]!
      const transitionScore =
        (Math.hypot(transitionX - startX, transitionY - startY) +
          Math.hypot(endX - transitionX, endY - transitionY)) *
          distanceToCost +
        layerTransitionCost

      if (transitionScore >= bestTransitionScore) continue

      bestTransitionScore = transitionScore
      layerTransitionRegionIdByRoute[routeId] = regionId
      layerTransitionCostByRoute[routeId] = layerTransitionCost
    }
  }

  return {
    layerTransitionRegionIdByRoute,
    layerTransitionCostByRoute,
  }
}

/**
 * Guides ports that remain on the start layer through the selected transition
 * region. After the route changes layer, the original direct-distance
 * heuristic applies.
 */
export const getLayerAwarePortHeuristicCost = ({
  topology,
  problem,
  layerAwareRouteHeuristic,
  distanceToCost,
  routeId,
  portId,
}: GetLayerAwarePortHeuristicCostContext): number => {
  const endPortId = problem.routeEndPort[routeId]!
  const portX = getPortRoutingCostX(topology, portId)
  const portY = getPortRoutingCostY(topology, portId)
  const endX = getPortRoutingCostX(topology, endPortId)
  const endY = getPortRoutingCostY(topology, endPortId)
  const directCost = Math.hypot(portX - endX, portY - endY) * distanceToCost
  const startPortId = problem.routeStartPort[routeId]!

  if (topology.portZ[portId] !== topology.portZ[startPortId]) {
    return directCost
  }

  const layerTransitionRegionId =
    layerAwareRouteHeuristic.layerTransitionRegionIdByRoute[routeId]!

  if (layerTransitionRegionId === -1) return directCost

  const transitionX = topology.regionCenterX[layerTransitionRegionId]!
  const transitionY = topology.regionCenterY[layerTransitionRegionId]!

  return (
    (Math.hypot(transitionX - portX, transitionY - portY) +
      Math.hypot(endX - transitionX, endY - transitionY)) *
      distanceToCost +
    layerAwareRouteHeuristic.layerTransitionCostByRoute[routeId]!
  )
}
