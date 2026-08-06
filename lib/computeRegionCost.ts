export const DEFAULT_MIN_VIA_PAD_DIAMETER = 0.3
export const TRACE_VIA_MARGIN = 0.15
const traceWidth = 0.1
const TRACE_PITCH = traceWidth + TRACE_VIA_MARGIN
const FULL_REGION_OVER_CAPACITY_COST = 20
const IMPOSSIBLE_SINGLE_LAYER_INTERSECTION_COST = 10

export const isKnownSingleLayerMask = (regionAvailableZMask: number) =>
  regionAvailableZMask > 0 &&
  (regionAvailableZMask & (regionAvailableZMask - 1)) === 0

const countAvailableLayers = (regionAvailableZMask: number) => {
  let remainingMask = regionAvailableZMask
  let layerCount = 0
  while (remainingMask > 0) {
    layerCount += remainingMask & 1
    remainingMask >>>= 1
  }
  return Math.max(1, layerCount)
}

/**
 * Upper bound for traces crossing a rectangular region. Each crossing trace
 * consumes two boundary slots, and each layer supplies its own slots.
 */
export const getRegionTraceCapacity = (
  regionWidth: number,
  regionHeight: number,
  regionAvailableZMask: number,
) =>
  Math.max(
    1,
    Math.floor(
      ((regionWidth + regionHeight) *
        countAvailableLayers(regionAvailableZMask)) /
        TRACE_PITCH,
    ),
  )

/**
 * Leaves feasible region usage unchanged and progressively penalizes only the
 * portion above the region's physical crossing capacity.
 */
export const computeRegionTraceCapacityCost = (
  regionWidth: number,
  regionHeight: number,
  traceCount: number,
  regionAvailableZMask: number,
) => {
  const traceCapacity = getRegionTraceCapacity(
    regionWidth,
    regionHeight,
    regionAvailableZMask,
  )
  const overCapacityRatio =
    Math.max(0, traceCount - traceCapacity) / traceCapacity
  return FULL_REGION_OVER_CAPACITY_COST * overCapacityRatio ** 2
}

export const computeRegionCost = (
  regionWidth: number,
  regionHeight: number,
  numSameLayerIntersections: number,
  numCrossLayerIntersections: number,
  numEntryExitChanges: number,
  traceCount: number,
  regionAvailableZMask = 0,
  minViaPadDiameter = DEFAULT_MIN_VIA_PAD_DIAMETER,
) => {
  const area = regionWidth * regionHeight

  return computeRegionCostForArea(
    area,
    numSameLayerIntersections,
    numCrossLayerIntersections,
    numEntryExitChanges,
    traceCount,
    regionAvailableZMask,
    minViaPadDiameter,
  )
}

export const computeRegionCostForArea = (
  area: number,
  numSameLayerIntersections: number,
  numCrossLayerIntersections: number,
  numEntryExitChanges: number,
  traceCount: number,
  regionAvailableZMask = 0,
  minViaPadDiameter = DEFAULT_MIN_VIA_PAD_DIAMETER,
) => {
  const estViasRequired =
    numSameLayerIntersections * 2 +
    numCrossLayerIntersections * 1 +
    numEntryExitChanges * 1
  const viaSizeWithMargin = minViaPadDiameter + TRACE_VIA_MARGIN
  const viaSizeWithMarginSq = viaSizeWithMargin ** 2

  const traceCountMult = 1 + traceCount / 5
  const impossibleSingleLayerIntersectionCost = isKnownSingleLayerMask(
    regionAvailableZMask,
  )
    ? numSameLayerIntersections * IMPOSSIBLE_SINGLE_LAYER_INTERSECTION_COST
    : 0

  return (
    (estViasRequired * viaSizeWithMarginSq * traceCountMult) / area +
    impossibleSingleLayerIntersectionCost
  )
}
