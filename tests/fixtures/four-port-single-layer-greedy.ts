import type { SerializedHyperGraph } from "@tscircuit/hypergraph"

export function createFourPortSingleLayerGreedyGraph(
  crossing: boolean,
): SerializedHyperGraph {
  const terminalSpecs = [
    ["a-top", 0, 1, "a-top-region"],
    ["b-right", 1, 0, "b-right-region"],
    ["a-bottom", 0, -1, "a-bottom-region"],
    ["b-left", -1, 0, "b-left-region"],
  ] as const

  return {
    regions: [
      {
        regionId: "center-z0",
        pointIds: terminalSpecs.map(([portId]) => portId),
        d: {
          capacityMeshNodeId: "center-z0",
          center: { x: 0, y: 0 },
          width: 2,
          height: 2,
          availableZ: [0],
        },
      },
      ...terminalSpecs.map(([portId, x, y, regionId]) => ({
        regionId,
        pointIds: [portId],
        d: {
          capacityMeshNodeId: regionId,
          center: { x, y },
          width: 1e-6,
          height: 1e-6,
          availableZ: [0],
          _containsTarget: true,
        },
      })),
    ],
    ports: terminalSpecs.map(([portId, x, y, regionId]) => ({
      portId,
      region1Id: "center-z0",
      region2Id: regionId,
      d: { portId, x, y, z: 0, distToCentermostPortOnZ: 0 },
    })),
    connections: crossing
      ? [
          {
            connectionId: "route-a",
            mutuallyConnectedNetworkId: "net-a",
            startRegionId: "a-top-region",
            endRegionId: "a-bottom-region",
          },
          {
            connectionId: "route-b",
            mutuallyConnectedNetworkId: "net-b",
            startRegionId: "b-right-region",
            endRegionId: "b-left-region",
          },
        ]
      : [
          {
            connectionId: "route-a",
            mutuallyConnectedNetworkId: "net-a",
            startRegionId: "a-top-region",
            endRegionId: "b-right-region",
          },
          {
            connectionId: "route-b",
            mutuallyConnectedNetworkId: "net-b",
            startRegionId: "a-bottom-region",
            endRegionId: "b-left-region",
          },
        ],
  }
}
