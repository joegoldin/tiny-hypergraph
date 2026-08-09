import { expect, test } from "bun:test"
import type { SerializedHyperGraph } from "@tscircuit/hypergraph"
import { loadSerializedHyperGraph } from "lib/compat/loadSerializedHyperGraph"

test("loadSerializedHyperGraph maps serialized port penalties into the problem", () => {
  const graph: SerializedHyperGraph = {
    regions: [
      {
        regionId: "region-a",
        pointIds: ["penalized-port"],
        d: { center: { x: 0, y: 0 }, width: 1, height: 1 },
      },
      {
        regionId: "region-b",
        pointIds: ["penalized-port", "invalid-port"],
        d: { center: { x: 1, y: 0 }, width: 1, height: 1 },
      },
      {
        regionId: "region-c",
        pointIds: ["invalid-port"],
        d: { center: { x: 2, y: 0 }, width: 1, height: 1 },
      },
    ],
    ports: [
      {
        portId: "penalized-port",
        region1Id: "region-a",
        region2Id: "region-b",
        d: { x: 0.5, y: 0, z: 0, tinyHypergraphPortPenalty: 12.5 },
      },
      {
        portId: "invalid-port",
        region1Id: "region-b",
        region2Id: "region-c",
        d: { x: 1.5, y: 0, z: 0, tinyHypergraphPortPenalty: -4 },
      },
    ],
    connections: [],
  }

  const { problem } = loadSerializedHyperGraph(graph)

  expect(Array.from(problem.portPenalty ?? [])).toEqual([12.5, 0])
})
