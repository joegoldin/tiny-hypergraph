import "bun-match-svg"
import { expect, test } from "bun:test"
import type { SerializedHyperGraph } from "@tscircuit/hypergraph"
import {
  getSvgFromGraphicsObject,
  stackGraphicsVertically,
} from "graphics-debug"
import {
  FixedTopologyPortalLayerRefinementSolver,
  loadSerializedHyperGraph,
} from "lib/index"

const createRegion = (regionId: string, pointIds: string[]) => ({
  regionId,
  pointIds,
  d: {
    center: { x: 0, y: 0 },
    width: 10,
    height: 10,
    availableZ: [0, 1],
  },
})

const graph = {
  regions: [
    createRegion("start", ["start-port"]),
    createRegion("r0", ["start-port", "g1-z0", "g1-z1"]),
    createRegion("r1", ["g1-z0", "g1-z1", "g2-z0", "g2-z1"]),
    createRegion("r2", ["g2-z0", "g2-z1", "end-port"]),
    createRegion("end", ["end-port"]),
  ],
  ports: [
    {
      portId: "start-port",
      region1Id: "start",
      region2Id: "r0",
      d: { x: -3, y: 0, z: 0 },
    },
    {
      portId: "g1-z0",
      region1Id: "r0",
      region2Id: "r1",
      d: { x: -1, y: 0, z: 0, physicalPortGroupId: "g1" },
    },
    {
      portId: "g1-z1",
      region1Id: "r0",
      region2Id: "r1",
      d: { x: -1, y: 0, z: 1, physicalPortGroupId: "g1" },
    },
    {
      portId: "g2-z0",
      region1Id: "r1",
      region2Id: "r2",
      d: { x: 1, y: 0, z: 0, physicalPortGroupId: "g2" },
    },
    {
      portId: "g2-z1",
      region1Id: "r1",
      region2Id: "r2",
      d: { x: 1, y: 0, z: 1, physicalPortGroupId: "g2" },
    },
    {
      portId: "end-port",
      region1Id: "r2",
      region2Id: "end",
      d: { x: 3, y: 0, z: 0 },
    },
  ],
  connections: [
    {
      connectionId: "route-a",
      startRegionId: "start",
      endRegionId: "end",
    },
  ],
  solvedRoutes: [
    {
      connection: {
        connectionId: "route-a",
        startRegionId: "start",
        endRegionId: "end",
      },
      requiredRip: false,
      path: [
        {
          portId: "start-port",
          nextRegionId: "r0",
          g: 0,
          h: 0,
          f: 0,
          hops: 0,
          ripRequired: false,
        },
        {
          portId: "g1-z0",
          lastRegionId: "r0",
          nextRegionId: "r1",
          g: 1,
          h: 0,
          f: 1,
          hops: 1,
          ripRequired: false,
        },
        {
          portId: "g2-z1",
          lastRegionId: "r1",
          nextRegionId: "r2",
          g: 2,
          h: 0,
          f: 2,
          hops: 2,
          ripRequired: false,
        },
        {
          portId: "end-port",
          lastRegionId: "r2",
          nextRegionId: "end",
          g: 3,
          h: 0,
          f: 3,
          hops: 3,
          ripRequired: false,
        },
      ],
    },
  ],
} as SerializedHyperGraph

test("refines portal layers while preserving the fixed region sequence", () => {
  const { topology, problem, solution } = loadSerializedHyperGraph(graph)
  expect(topology.physicalPortalGroupCount).toBe(2)
  expect(
    topology.portPhysicalGroupId?.[1],
  ).toBe(topology.portPhysicalGroupId?.[2])
  expect(
    topology.portPhysicalGroupId?.[3],
  ).toBe(topology.portPhysicalGroupId?.[4])
  const solver = new FixedTopologyPortalLayerRefinementSolver(
    topology,
    problem,
    solution,
  )
  const beforeRefinementGraphics = solver.visualize()

  solver.solve()

  const output = solver.getOutput()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.stats.predictedViaDemandBefore).toBe(2)
  expect(solver.stats.predictedViaDemandAfter).toBe(0)
  expect(solver.stats.acceptedCandidateCount).toBe(1)
  expect(
    output.solvedRoutes?.[0]?.path.map((candidate) => candidate.nextRegionId),
  ).toEqual(["r0", "r1", "r2", "end"])
  expect(
    output.solvedRoutes?.[0]?.path.map((candidate) => candidate.portId),
  ).toEqual(["start-port", "g1-z0", "g2-z0", "end-port"])
  const stagedSvg = getSvgFromGraphicsObject(
    stackGraphicsVertically(
      [beforeRefinementGraphics, solver.visualize()],
      { titles: ["before refinement", "after refinement"] },
    ),
  )
  expect(stagedSvg).toMatchSvgSnapshot(import.meta.path)

  const repeatedLoad = loadSerializedHyperGraph(graph)
  const repeatedSolver = new FixedTopologyPortalLayerRefinementSolver(
    repeatedLoad.topology,
    repeatedLoad.problem,
    repeatedLoad.solution,
  )
  repeatedSolver.solve()
  expect(repeatedSolver.getOutput()).toEqual(output)

  const lockedLoad = loadSerializedHyperGraph(graph)
  lockedLoad.problem.portalLayerRefinementLockedRouteMask =
    Int8Array.from([1])
  const lockedSolver = new FixedTopologyPortalLayerRefinementSolver(
    lockedLoad.topology,
    lockedLoad.problem,
    lockedLoad.solution,
  )
  lockedSolver.solve()
  expect(lockedSolver.stats.acceptedCandidateCount).toBe(0)
  expect(
    lockedSolver
      .getOutput()
      .solvedRoutes?.[0]?.path.map((candidate) => candidate.portId),
  ).toEqual(["start-port", "g1-z0", "g2-z1", "end-port"])

  const reservedAlternativeLoad = loadSerializedHyperGraph(graph)
  reservedAlternativeLoad.problem.routeCount = 2
  reservedAlternativeLoad.problem.routeStartPort = Int32Array.from([0, 3])
  reservedAlternativeLoad.problem.routeEndPort = Int32Array.from([5, 3])
  reservedAlternativeLoad.problem.routeNet = Int32Array.from([0, 1])
  reservedAlternativeLoad.problem.routeMetadata = [
    ...(reservedAlternativeLoad.problem.routeMetadata ?? []),
    { connectionId: "fixed-port-owner" },
  ]
  reservedAlternativeLoad.problem.portalLayerRefinementLockedRouteMask =
    Int8Array.from([0, 1])
  reservedAlternativeLoad.solution.solvedRoutePathSegments.push([])
  reservedAlternativeLoad.solution.solvedRoutePathRegionIds?.push([])
  const reservedAlternativeSolver =
    new FixedTopologyPortalLayerRefinementSolver(
      reservedAlternativeLoad.topology,
      reservedAlternativeLoad.problem,
      reservedAlternativeLoad.solution,
    )
  reservedAlternativeSolver.solve()
  expect(reservedAlternativeSolver.stats.acceptedCandidateCount).toBe(0)
  expect(
    reservedAlternativeSolver.routePlans[0]?.orderedPortIds,
  ).toEqual([0, 1, 4, 5])
})
