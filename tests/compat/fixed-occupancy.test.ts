import { expect, test } from "bun:test"
import type { SerializedHyperGraph } from "@tscircuit/hypergraph"
import {
  loadSerializedHyperGraph,
  TinyHyperGraphSectionPipelineSolver,
  TinyHyperGraphSolver,
} from "lib/index"

const graph: SerializedHyperGraph = {
  regions: [
    {
      regionId: "left",
      pointIds: ["p-left"],
      d: { bounds: { minX: -2, maxX: -1, minY: -1, maxY: 1 } },
    },
    {
      regionId: "center",
      pointIds: ["p-left", "p-top", "p-right", "p-bottom"],
      d: { bounds: { minX: -1, maxX: 1, minY: -1, maxY: 1 } },
    },
    {
      regionId: "right",
      pointIds: ["p-right"],
      d: { bounds: { minX: 1, maxX: 2, minY: -1, maxY: 1 } },
    },
    {
      regionId: "top",
      pointIds: ["p-top"],
      d: { bounds: { minX: -1, maxX: 1, minY: 1, maxY: 2 } },
    },
    {
      regionId: "bottom",
      pointIds: ["p-bottom"],
      d: { bounds: { minX: -1, maxX: 1, minY: -2, maxY: -1 } },
    },
  ],
  ports: [
    {
      portId: "p-left",
      region1Id: "left",
      region2Id: "center",
      d: { x: -1, y: 0, z: 0 },
    },
    {
      portId: "p-top",
      region1Id: "center",
      region2Id: "top",
      d: { x: 0, y: 1, z: 0 },
    },
    {
      portId: "p-right",
      region1Id: "center",
      region2Id: "right",
      d: { x: 1, y: 0, z: 0 },
    },
    {
      portId: "p-bottom",
      region1Id: "center",
      region2Id: "bottom",
      d: { x: 0, y: -1, z: 0 },
    },
  ],
  connections: [
    {
      connectionId: "route-a",
      mutuallyConnectedNetworkId: "net-a",
      startRegionId: "left",
      endRegionId: "right",
    },
  ],
}

test("loads serialized fixed occupancy without changing graph topology", () => {
  const loaded = loadSerializedHyperGraph({
    ...graph,
    fixedOccupancy: {
      segments: [
        {
          regionId: "center",
          fromPortId: "p-top",
          toPortId: "p-bottom",
          networkId: "net-a",
        },
        {
          regionId: "center",
          fromPortId: "p-left",
          toPortId: "p-right",
          networkId: "fixed-only-net",
        },
      ],
    },
  })

  expect(loaded.topology.regionCount).toBe(graph.regions.length)
  expect(loaded.topology.portCount).toBe(graph.ports.length)
  expect(loaded.problem.fixedOccupancy?.segments).toEqual([
    {
      regionId: 1,
      fromPortId: 1,
      toPortId: 3,
      netId: loaded.problem.routeNet[0],
      networkId: "net-a",
    },
    {
      regionId: 1,
      fromPortId: 0,
      toPortId: 2,
      netId: loaded.problem.routeNet[0]! + 1,
      networkId: "fixed-only-net",
    },
  ])
})

test("reports missing serialized fixed occupancy ids clearly", () => {
  expect(() =>
    loadSerializedHyperGraph({
      ...graph,
      fixedOccupancy: {
        portReservations: [{ portId: "missing-port", networkId: "net-a" }],
      },
    }),
  ).toThrow('Fixed occupancy references missing port "missing-port"')
})

test("section pipeline accepts serialized fixed occupancy directly", () => {
  const pipeline = new TinyHyperGraphSectionPipelineSolver({
    serializedHyperGraph: {
      ...graph,
      fixedOccupancy: {
        segments: [
          {
            regionId: "center",
            fromPortId: "p-top",
            toPortId: "p-bottom",
            networkId: "net-a",
          },
        ],
      },
    },
  })

  const initialSolver = pipeline.getInitialVisualizationSolver()
  const fixedLines = (pipeline.initialVisualize()?.lines ?? []).filter((line) =>
    line.label?.includes("fixed occupancy"),
  )

  expect(initialSolver.topology.regionCount).toBe(graph.regions.length)
  expect(initialSolver.topology.portCount).toBe(graph.ports.length)
  expect(initialSolver.problem.fixedOccupancy?.segments).toHaveLength(1)
  expect(fixedLines).toHaveLength(1)
  expect(fixedLines[0]?.layer).toBe("z0")
})

test("solver output preserves serialized fixed occupancy", () => {
  const fixedOccupancy = {
    segments: [
      {
        regionId: "center",
        fromPortId: "p-top",
        toPortId: "p-bottom",
        networkId: "net-a",
        d: { traceId: "trace-1" },
      },
    ],
  }
  const loaded = loadSerializedHyperGraph({ ...graph, fixedOccupancy })
  const solver = new TinyHyperGraphSolver(loaded.topology, loaded.problem, {
    STATIC_REACHABILITY_PRECHECK: false,
  })

  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.getOutput().fixedOccupancy).toEqual(fixedOccupancy)
})
