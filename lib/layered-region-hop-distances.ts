import type { TinyHyperGraphProblem, TinyHyperGraphTopology } from "./core"
import type { NetId, PortId, RegionId } from "./types"

type LayeredRegionHopDistanceParams = {
  topology: TinyHyperGraphTopology
  problem: TinyHyperGraphProblem
  routeNetId: NetId
  goalPortId: PortId
  layerCount: number
}

type LayeredRegionStateParams = {
  regionId: RegionId
  z: number
  layerCount: number
}

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

const getLayeredRegionStateId = ({
  regionId,
  z,
  layerCount,
}: LayeredRegionStateParams): number => regionId * layerCount + z

const addUnvisitedState = ({
  distances,
  queue,
  stateId,
  distance,
}: {
  distances: Int32Array
  queue: number[]
  stateId: number
  distance: number
}): void => {
  if (distances[stateId] !== -1) return
  distances[stateId] = distance
  queue.push(stateId)
}

/**
 * Computes reverse graph distance while preserving the copper layer. Layer
 * changes only exist inside regions that expose ports on both layers.
 */
export const getLayeredRegionHopDistances = ({
  topology,
  problem,
  routeNetId,
  goalPortId,
  layerCount,
}: LayeredRegionHopDistanceParams): Int32Array => {
  const distances = new Int32Array(topology.regionCount * layerCount).fill(-1)
  const queue: number[] = []
  const goalZ = topology.portZ[goalPortId]!

  for (const goalRegionId of topology.incidentPortRegion[goalPortId] ?? []) {
    if (isRegionBlocked({ problem, routeNetId, regionId: goalRegionId })) {
      continue
    }
    addUnvisitedState({
      distances,
      queue,
      stateId: getLayeredRegionStateId({
        regionId: goalRegionId,
        z: goalZ,
        layerCount,
      }),
      distance: 0,
    })
  }

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const stateId = queue[queueIndex]!
    const regionId = Math.floor(stateId / layerCount)
    const z = stateId % layerCount
    const nextDistance = distances[stateId]! + 1

    for (const portId of topology.regionIncidentPorts[regionId] ?? []) {
      const portZ = topology.portZ[portId]!
      if (portZ !== z) {
        addUnvisitedState({
          distances,
          queue,
          stateId: getLayeredRegionStateId({ regionId, z: portZ, layerCount }),
          distance: nextDistance,
        })
        continue
      }

      for (const neighborRegionId of
        topology.incidentPortRegion[portId] ?? []) {
        if (
          neighborRegionId === regionId ||
          isRegionBlocked({
            problem,
            routeNetId,
            regionId: neighborRegionId,
          })
        ) {
          continue
        }
        addUnvisitedState({
          distances,
          queue,
          stateId: getLayeredRegionStateId({
            regionId: neighborRegionId,
            z,
            layerCount,
          }),
          distance: nextDistance,
        })
      }
    }
  }

  return distances
}

export const getLayeredRegionHopDistance = ({
  distances,
  regionId,
  z,
  layerCount,
}: {
  distances: Int32Array
  regionId: RegionId
  z: number
  layerCount: number
}): number =>
  Math.max(
    0,
    distances[getLayeredRegionStateId({ regionId, z, layerCount })] ?? -1,
  )
