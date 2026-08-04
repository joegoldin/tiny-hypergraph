import { expect, test } from "bun:test"
import { orderConnectionsByNetCardinality } from "lib/selective-rerip-tiny-hyper-graph-solver"

test("selective rerip interleaves nets while preserving cardinality priority", () => {
  const connections = [
    { id: 0, netId: "a" },
    { id: 1, netId: "b" },
    { id: 2, netId: "a" },
    { id: 3, netId: "c" },
    { id: 4, netId: "b" },
    { id: 5, netId: "a" },
    { id: 6, netId: "d" },
  ]

  expect(
    orderConnectionsByNetCardinality(
      connections,
      (connection) => connection.netId,
    ).map((connection) => connection.id),
  ).toEqual([0, 1, 3, 6, 2, 4, 5])
})
