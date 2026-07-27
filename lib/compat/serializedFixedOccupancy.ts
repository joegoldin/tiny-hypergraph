import type { SerializedHyperGraph } from "@tscircuit/hypergraph"

export interface SerializedTinyHyperGraphFixedPortReservation {
  portId: string
  networkId: string
  d?: unknown
}

export interface SerializedTinyHyperGraphFixedSegment {
  regionId: string
  fromPortId: string
  toPortId: string
  networkId: string
  geometry?: {
    start: { x: number; y: number }
    end: { x: number; y: number }
  }
  d?: unknown
}

export interface SerializedTinyHyperGraphFixedOccupancy {
  portReservations?: SerializedTinyHyperGraphFixedPortReservation[]
  segments?: SerializedTinyHyperGraphFixedSegment[]
}

/**
 * Compatible with @tscircuit/hypergraph's canonical fixedOccupancy field.
 * The intersection can be removed after that package version is required.
 */
export type SerializedTinyHyperGraph = SerializedHyperGraph & {
  fixedOccupancy?: SerializedTinyHyperGraphFixedOccupancy
}
