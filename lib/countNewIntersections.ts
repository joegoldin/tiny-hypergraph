import type { DynamicAnglePair, DynamicAnglePairArrays } from "./types"

export type RegionCostModel = "legacy" | "routing-risk"

export const classifyIntersectionLayerMasks = (
  firstLayerMask: number,
  secondLayerMask: number,
  regionCostModel: RegionCostModel,
): "same-layer" | "transition-pair" | undefined => {
  if (regionCostModel === "legacy") {
    return (firstLayerMask & secondLayerMask) !== 0
      ? "same-layer"
      : "transition-pair"
  }

  const firstChangesLayer =
    firstLayerMask > 0 && (firstLayerMask & (firstLayerMask - 1)) !== 0
  const secondChangesLayer =
    secondLayerMask > 0 && (secondLayerMask & (secondLayerMask - 1)) !== 0
  if (firstChangesLayer || secondChangesLayer) {
    return firstChangesLayer && secondChangesLayer
      ? "transition-pair"
      : undefined
  }
  return (firstLayerMask & secondLayerMask) !== 0 ? "same-layer" : undefined
}

export const createDynamicAnglePairArrays = (
  anglePairs: Array<DynamicAnglePair>,
): DynamicAnglePairArrays => {
  const netIds = new Int32Array(anglePairs.length)
  const lesserAngles = new Int32Array(anglePairs.length)
  const greaterAngles = new Int32Array(anglePairs.length)
  const layerMasks = new Int32Array(anglePairs.length)

  for (let i = 0; i < anglePairs.length; i++) {
    const [netId, lesserAngle, z1, greaterAngle, z2] = anglePairs[i]
    netIds[i] = netId
    lesserAngles[i] = lesserAngle
    greaterAngles[i] = greaterAngle
    layerMasks[i] = (1 << z1) | (1 << z2)
  }

  return {
    netIds,
    lesserAngles,
    greaterAngles,
    layerMasks,
  }
}

export const countNewIntersectionsWithValues = (
  existingPairs: DynamicAnglePairArrays,
  newNet: number,
  newLesserAngle: number,
  newGreaterAngle: number,
  newLayerMask: number,
  entryExitLayerChanges: number,
  regionCostModel: RegionCostModel = "legacy",
): [number, number, number] => {
  const { netIds, lesserAngles, greaterAngles, layerMasks } = existingPairs

  let sameLayerIntersectionCount = 0
  let crossingLayerIntersectionCount = 0

  for (let i = 0; i < netIds.length; i++) {
    if (newNet === netIds[i]) continue

    const lesserAngleIsInsideInterval =
      newLesserAngle < lesserAngles[i] && lesserAngles[i] < newGreaterAngle
    const greaterAngleIsInsideInterval =
      newLesserAngle < greaterAngles[i] && greaterAngles[i] < newGreaterAngle

    if (lesserAngleIsInsideInterval === greaterAngleIsInsideInterval) continue

    const intersectionKind = classifyIntersectionLayerMasks(
      newLayerMask,
      layerMasks[i]!,
      regionCostModel,
    )
    if (intersectionKind === "same-layer") {
      sameLayerIntersectionCount++
    } else if (intersectionKind === "transition-pair") {
      crossingLayerIntersectionCount++
    }
  }

  return [
    sameLayerIntersectionCount,
    crossingLayerIntersectionCount,
    entryExitLayerChanges,
  ]
}

export const countNewIntersections = (
  existingPairs: DynamicAnglePairArrays,
  newPair: DynamicAnglePair,
  regionCostModel: RegionCostModel = "legacy",
): [number, number, number] => {
  const [newNet, newLesserAngle, newZ1, newGreaterAngle, newZ2] = newPair
  return countNewIntersectionsWithValues(
    existingPairs,
    newNet,
    newLesserAngle,
    newGreaterAngle,
    (1 << newZ1) | (1 << newZ2),
    newZ1 !== newZ2 ? 1 : 0,
    regionCostModel,
  )
}

export const countIntersectionsFromAnglePairsDynamic = countNewIntersections
