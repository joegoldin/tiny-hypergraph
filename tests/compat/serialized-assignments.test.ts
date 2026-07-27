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
      regionId: "start",
      pointIds: ["p0"],
      d: { bounds: { minX: -2, maxX: -1, minY: -1, maxY: 1 } },
    },
    {
      regionId: "middle-left",
      pointIds: ["p0", "p1"],
      assignments: [
        {
          regionPort1Id: "p0",
          regionPort2Id: "p1",
          connectionId: "route-a",
        },
      ],
      d: { bounds: { minX: -1, maxX: 0, minY: -1, maxY: 1 } },
    },
    {
      regionId: "middle-right",
      pointIds: ["p1", "p2"],
      assignments: [
        {
          regionPort1Id: "p1",
          regionPort2Id: "p2",
          connectionId: "route-a",
        },
      ],
      d: { bounds: { minX: 0, maxX: 1, minY: -1, maxY: 1 } },
    },
    {
      regionId: "end",
      pointIds: ["p2"],
      d: { bounds: { minX: 1, maxX: 2, minY: -1, maxY: 1 } },
    },
  ],
  ports: [
    {
      portId: "p0",
      region1Id: "start",
      region2Id: "middle-left",
      d: { x: -1, y: 0, z: 1 },
    },
    {
      portId: "p1",
      region1Id: "middle-left",
      region2Id: "middle-right",
      d: { x: 0, y: 0, z: 1 },
    },
    {
      portId: "p2",
      region1Id: "middle-right",
      region2Id: "end",
      d: { x: 1, y: 0, z: 1 },
    },
  ],
  connections: [
    {
      connectionId: "route-a",
      mutuallyConnectedNetworkId: "net-a",
      startRegionId: "start",
      endRegionId: "end",
    },
  ],
}

const crossingGraph: SerializedHyperGraph = {
  regions: [
    {
      regionId: "left",
      pointIds: ["left-port"],
      d: { bounds: { minX: -2, maxX: -1, minY: -1, maxY: 1 } },
    },
    {
      regionId: "top",
      pointIds: ["top-port"],
      d: { bounds: { minX: -1, maxX: 1, minY: 1, maxY: 2 } },
    },
    {
      regionId: "center",
      pointIds: ["left-port", "top-port", "right-port", "bottom-port"],
      assignments: [
        {
          regionPort1Id: "top-port",
          regionPort2Id: "bottom-port",
          connectionId: "vertical",
        },
      ],
      d: { bounds: { minX: -1, maxX: 1, minY: -1, maxY: 1 } },
    },
    {
      regionId: "right",
      pointIds: ["right-port"],
      d: { bounds: { minX: 1, maxX: 2, minY: -1, maxY: 1 } },
    },
    {
      regionId: "bottom",
      pointIds: ["bottom-port"],
      d: { bounds: { minX: -1, maxX: 1, minY: -2, maxY: -1 } },
    },
  ],
  ports: [
    {
      portId: "left-port",
      region1Id: "left",
      region2Id: "center",
      d: { x: -1, y: 0, z: 0 },
    },
    {
      portId: "top-port",
      region1Id: "top",
      region2Id: "center",
      d: { x: 0, y: 1, z: 0 },
    },
    {
      portId: "right-port",
      region1Id: "center",
      region2Id: "right",
      d: { x: 1, y: 0, z: 0 },
    },
    {
      portId: "bottom-port",
      region1Id: "center",
      region2Id: "bottom",
      d: { x: 0, y: -1, z: 0 },
    },
  ],
  connections: [
    {
      connectionId: "vertical",
      mutuallyConnectedNetworkId: "vertical-net",
      startRegionId: "top",
      endRegionId: "bottom",
    },
    {
      connectionId: "horizontal",
      mutuallyConnectedNetworkId: "horizontal-net",
      startRegionId: "left",
      endRegionId: "right",
    },
  ],
}

test("loads serialized region assignments without changing topology", () => {
  const loaded = loadSerializedHyperGraph(graph)
  const solver = new TinyHyperGraphSolver(loaded.topology, loaded.problem)

  expect(loaded.topology.regionCount).toBe(graph.regions.length)
  expect(loaded.topology.portCount).toBe(graph.ports.length)
  expect(loaded.problem.initialAssignments).toEqual([
    { routeId: 0, regionId: 1, fromPortId: 0, toPortId: 1 },
    { routeId: 0, regionId: 2, fromPortId: 1, toPortId: 2 },
  ])
  expect(solver.state.unroutedRoutes).toEqual([])
  expect(solver.state.regionSegments[1]).toEqual([[0, 0, 1]])
  expect(solver.state.regionSegments[2]).toEqual([[0, 1, 2]])
  expect(solver.state.regionIntersectionCaches[1]?.existingSegmentCount).toBe(1)
  expect(Array.from(solver.state.portAssignment)).toEqual([0, 0, 0])
})

test("serialized assignments remain route-owned and can be rerouted", () => {
  const loaded = loadSerializedHyperGraph(graph)
  const solver = new TinyHyperGraphSolver(loaded.topology, loaded.problem)

  solver.resetRoutingStateForRerip()

  expect(solver.state.regionSegments.flat()).toEqual([])
  expect(Array.from(solver.state.portAssignment)).toEqual([-1, -1, -1])
  expect(solver.state.unroutedRoutes).toEqual([0])
})

test("solver output preserves assignments and their layer", () => {
  const loaded = loadSerializedHyperGraph(graph)
  const solver = new TinyHyperGraphSolver(loaded.topology, loaded.problem)

  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.getOutput().regions[1]?.assignments).toEqual(
    graph.regions[1]?.assignments,
  )
  const assignmentLines = solver
    .visualize()
    .lines?.filter((line) => line.label?.includes("route: route-a"))
  expect(assignmentLines).toHaveLength(2)
  expect(assignmentLines?.every((line) => line.layer === "z1")).toBe(true)
})

test("section pipeline shows assignments at iteration zero", () => {
  const pipeline = new TinyHyperGraphSectionPipelineSolver({
    serializedHyperGraph: graph,
  })
  const assignmentLines = pipeline
    .initialVisualize()
    ?.lines?.filter((line) => line.label?.includes("route: route-a"))

  expect(pipeline.getInitialVisualizationSolver().state.unroutedRoutes).toEqual(
    [],
  )
  expect(assignmentLines).toHaveLength(2)
  expect(assignmentLines?.every((line) => line.layer === "z1")).toBe(true)
})

test("new routes detect crossings with preloaded assignments", () => {
  const loaded = loadSerializedHyperGraph(crossingGraph)
  const solver = new TinyHyperGraphSolver(loaded.topology, loaded.problem, {
    RIP_THRESHOLD_RAMP_ATTEMPTS: 0,
  })

  solver.solve()

  const centerRegionIndex = crossingGraph.regions.findIndex(
    (region) => region.regionId === "center",
  )
  expect(solver.solved).toBe(true)
  expect(
    solver.state.regionIntersectionCaches[centerRegionIndex]
      ?.existingSameLayerIntersections,
  ).toBe(1)
})

test("reports an assignment with an unknown connection", () => {
  const invalidGraph = structuredClone(graph)
  invalidGraph.regions[1]!.assignments![0]!.connectionId = "missing"

  expect(() => loadSerializedHyperGraph(invalidGraph)).toThrow(
    'Region "middle-left" assignment references unknown routable connection "missing"',
  )
})
