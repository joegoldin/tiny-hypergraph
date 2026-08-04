import { expect, test } from "bun:test"
import { orderConflictComponentRoutes } from "lib/selective-rerip-tiny-hyper-graph-solver"

test("orders the connected conflict component with blocked routes before owners", () => {
  expect(
    orderConflictComponentRoutes({
      pendingRouteIds: [8, 3],
      failedOwnerPairs: [
        { failedRouteId: 8, ownerRouteId: 5, count: 1 },
        { failedRouteId: 5, ownerRouteId: 2, count: 1 },
        { failedRouteId: 11, ownerRouteId: 8, count: 1 },
        { failedRouteId: 10, ownerRouteId: 9, count: 1 },
      ],
    }),
  ).toEqual({
    routeIds: [3, 11, 8, 5, 2],
    cyclicRouteIds: [],
  })
})
