import type { TinyHyperGraphProblem, TinyHyperGraphTopology } from "./core"
import { MinHeap } from "./MinHeap"
import type { NetId, PortId, RegionId } from "./types"

type PortPenaltyEdge = {
  componentId: number
  penalty: number
}

type ComponentPenaltyCandidate = {
  componentId: number
  cost: number
}

export type PortPenaltyComponentGraph = {
  componentByRegion: Int32Array
  componentNetId: Int32Array
  edgesByComponent: PortPenaltyEdge[][]
}

export type MinimumPortPenaltyByRegion = {
  componentByRegion: Int32Array
  costByComponent: Float64Array
}

type MinimumPortPenaltyParams = {
  graph: PortPenaltyComponentGraph
  topology: TinyHyperGraphTopology
  routeNetId: NetId
  goalPortId: PortId
}

const compareCandidatesByCost = (
  left: ComponentPenaltyCandidate,
  right: ComponentPenaltyCandidate,
): number => left.cost - right.cost

const findRoot = (parents: Int32Array, item: number): number => {
  let root = item
  while (parents[root] !== root) root = parents[root]!

  let current = item
  while (parents[current] !== current) {
    const parent = parents[current]!
    parents[current] = root
    current = parent
  }
  return root
}

const union = (parents: Int32Array, left: number, right: number): void => {
  const leftRoot = findRoot(parents, left)
  const rightRoot = findRoot(parents, right)
  if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot
}

const getPortPenalty = (
  problem: TinyHyperGraphProblem,
  portId: PortId,
): number => problem.portPenalty?.[portId] ?? 0

const connectZeroPenaltyRegions = ({
  topology,
  problem,
  parents,
}: {
  topology: TinyHyperGraphTopology
  problem: TinyHyperGraphProblem
  parents: Int32Array
}): void => {
  for (let portId = 0; portId < topology.portCount; portId++) {
    if (
      problem.portSectionMask[portId] === 0 ||
      getPortPenalty(problem, portId) > 0
    ) {
      continue
    }

    const incidentRegions = topology.incidentPortRegion[portId]
    for (let leftIndex = 0; leftIndex < incidentRegions.length; leftIndex++) {
      const leftRegionId = incidentRegions[leftIndex]!
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < incidentRegions.length;
        rightIndex++
      ) {
        const rightRegionId = incidentRegions[rightIndex]!
        if (
          problem.regionNetId[leftRegionId] ===
          problem.regionNetId[rightRegionId]
        ) {
          union(parents, leftRegionId, rightRegionId)
        }
      }
    }
  }
}

const getComponentIds = ({
  parents,
  regionNetId,
}: {
  parents: Int32Array
  regionNetId: Int32Array
}): Pick<
  PortPenaltyComponentGraph,
  "componentByRegion" | "componentNetId"
> => {
  const componentByRoot = new Map<number, number>()
  const componentByRegion = new Int32Array(parents.length)
  const componentNetIds: number[] = []

  for (let regionId = 0; regionId < parents.length; regionId++) {
    const root = findRoot(parents, regionId)
    let componentId = componentByRoot.get(root)
    if (componentId === undefined) {
      componentId = componentByRoot.size
      componentByRoot.set(root, componentId)
      componentNetIds.push(regionNetId[regionId]!)
    }
    componentByRegion[regionId] = componentId
  }

  return {
    componentByRegion,
    componentNetId: Int32Array.from(componentNetIds),
  }
}

const addMinimumPenaltyEdge = ({
  edgeMaps,
  fromComponentId,
  toComponentId,
  penalty,
}: {
  edgeMaps: Array<Map<number, number>>
  fromComponentId: number
  toComponentId: number
  penalty: number
}): void => {
  if (fromComponentId === toComponentId) return
  const currentPenalty = edgeMaps[fromComponentId]!.get(toComponentId)
  if (currentPenalty === undefined || penalty < currentPenalty) {
    edgeMaps[fromComponentId]!.set(toComponentId, penalty)
  }
}

const getComponentEdges = ({
  topology,
  problem,
  componentByRegion,
  componentCount,
}: {
  topology: TinyHyperGraphTopology
  problem: TinyHyperGraphProblem
  componentByRegion: Int32Array
  componentCount: number
}): PortPenaltyEdge[][] => {
  const edgeMaps = Array.from(
    { length: componentCount },
    () => new Map<number, number>(),
  )

  for (let portId = 0; portId < topology.portCount; portId++) {
    if (problem.portSectionMask[portId] === 0) continue
    const incidentRegions = topology.incidentPortRegion[portId]
    const penalty = getPortPenalty(problem, portId)

    for (let leftIndex = 0; leftIndex < incidentRegions.length; leftIndex++) {
      const leftComponentId = componentByRegion[incidentRegions[leftIndex]!]!
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < incidentRegions.length;
        rightIndex++
      ) {
        const rightComponentId =
          componentByRegion[incidentRegions[rightIndex]!]!
        addMinimumPenaltyEdge({
          edgeMaps,
          fromComponentId: leftComponentId,
          toComponentId: rightComponentId,
          penalty,
        })
        addMinimumPenaltyEdge({
          edgeMaps,
          fromComponentId: rightComponentId,
          toComponentId: leftComponentId,
          penalty,
        })
      }
    }
  }

  return edgeMaps.map((edgeMap) =>
    Array.from(edgeMap, ([componentId, penalty]) => ({
      componentId,
      penalty,
    })),
  )
}

/**
 * Collapses regions connected without a port penalty. The resulting graph is
 * equivalent for minimum-penalty searches, but is usually much smaller.
 */
export const getPortPenaltyComponentGraph = ({
  topology,
  problem,
}: {
  topology: TinyHyperGraphTopology
  problem: TinyHyperGraphProblem
}): PortPenaltyComponentGraph => {
  const parents = new Int32Array(topology.regionCount)
  for (let regionId = 0; regionId < topology.regionCount; regionId++) {
    parents[regionId] = regionId
  }
  connectZeroPenaltyRegions({ topology, problem, parents })
  const { componentByRegion, componentNetId } = getComponentIds({
    parents,
    regionNetId: problem.regionNetId,
  })

  return {
    componentByRegion,
    componentNetId,
    edgesByComponent: getComponentEdges({
      topology,
      problem,
      componentByRegion,
      componentCount: componentNetId.length,
    }),
  }
}

const isComponentBlocked = ({
  graph,
  routeNetId,
  componentId,
}: {
  graph: PortPenaltyComponentGraph
  routeNetId: NetId
  componentId: number
}): boolean => {
  const componentNetId = graph.componentNetId[componentId]
  return componentNetId !== -1 && componentNetId !== routeNetId
}

/**
 * Computes the minimum remaining fallback-port cost from each component to the
 * goal. This is a lower bound because it ignores congestion and port ownership.
 */
export const getMinimumPortPenaltyByRegion = ({
  graph,
  topology,
  routeNetId,
  goalPortId,
}: MinimumPortPenaltyParams): MinimumPortPenaltyByRegion => {
  const costs = new Float64Array(graph.edgesByComponent.length).fill(
    Number.POSITIVE_INFINITY,
  )
  const candidates = new MinHeap<ComponentPenaltyCandidate>(
    [],
    compareCandidatesByCost,
  )

  for (const regionId of topology.incidentPortRegion[goalPortId] ?? []) {
    const componentId = graph.componentByRegion[regionId]!
    if (
      isComponentBlocked({ graph, routeNetId, componentId }) ||
      costs[componentId] === 0
    ) {
      continue
    }
    costs[componentId] = 0
    candidates.queue({ componentId, cost: 0 })
  }

  while (candidates.length > 0) {
    const candidate = candidates.dequeue()!
    if (candidate.cost !== costs[candidate.componentId]) continue

    for (const edge of graph.edgesByComponent[candidate.componentId]!) {
      const nextCost = candidate.cost + edge.penalty
      if (
        isComponentBlocked({
          graph,
          routeNetId,
          componentId: edge.componentId,
        }) ||
        nextCost >= costs[edge.componentId]
      ) {
        continue
      }
      costs[edge.componentId] = nextCost
      candidates.queue({ componentId: edge.componentId, cost: nextCost })
    }
  }

  return {
    componentByRegion: graph.componentByRegion,
    costByComponent: costs,
  }
}

export const getMinimumPortPenalty = (
  minimumPenalty: MinimumPortPenaltyByRegion,
  regionId: RegionId,
): number => {
  const componentId = minimumPenalty.componentByRegion[regionId]!
  const cost = minimumPenalty.costByComponent[componentId]
  return Number.isFinite(cost) ? cost : 0
}
