# Compact candidate-hop search state

Date: 2026-08-11

## Goal

Find a profile-guided tiny-hypergraph optimization that improves dense SRJ18
routing without trading away completion or region cost, and verify that it is
also safe on the broader HG07 dataset. All measurements below used concurrency
1. `bugreport88` is not present in this repository and was not run.

The sample008 CPU profile was dominated by candidate scoring, heap maintenance,
and two-dimensional distance calculations. It also exposed a much larger
memory problem: candidate best-cost state reserved one entry for every
port/region pair, although a valid directed hop can only target a region
incident to its port.

For sample008 this meant 21,835 ports x 4,863 regions = 106,183,605 slots. The
`Float64Array` and generation `Uint32Array` together reserve 1,215.2 MiB for
that state. The topology's maximum port incidence is two, so the same legal
hop space needs only 43,670 slots, or 0.50 MiB.

## Retained changes

1. Assign compact hop ids by each port's incident-region slot. Dense best-cost
   arrays are now `portCount * maxPortIncidence`, while unusual manually
   constructed non-incident hops retain a Map fallback.
2. Give the indexed frontier the same compact topology index. Queued index and
   closed state use generation-scoped typed arrays rather than a Map and Set
   for every legal hop.
3. Sift the heap with a hole, reducing index updates from two writes per level
   to roughly one.
4. Reject closed hops and candidates whose conservative cost lower bound
   cannot beat the existing hop before intersection counting and region-cost
   evaluation.
5. Keep segment-distance composition in the core scoring path and reuse known
   outside-in distances. For finite 2D PCB coordinates, use direct
   `sqrt(dx*dx + dy*dy)` instead of variadic `hypot` scaling.
6. Cache the first two incident region ids in typed arrays for the common angle
   and hop-id lookups. Ports with more than two incident regions retain the
   general fallback loop.

The legacy `IndexedCandidateHeap(regionCount)` constructor remains supported;
the compact typed state is enabled only when topology indexing is supplied.

## SRJ18 same-machine results

Command in each checkout:

```sh
./benchmark.sh --concurrency 1
```

The final pair ran sequentially on the same host against `main` at `8fc61cf`.

| Metric | Main | Candidate | Speedup |
| --- | ---: | ---: | ---: |
| Total completion time | 22.182 s | 14.080 s | 1.575x |
| Average solveGraph | 2.477 s | 1.520 s | 1.630x |
| P50 duration | 1.571 s | 1.065 s | 1.475x |
| P95 duration | 7.715 s | 5.052 s | 1.527x |
| Route completion | 100.0% | 100.0% | unchanged |
| Average final max-region cost | 1.739 | 1.739 | exact match |

Every one of the eight sample final costs and statuses matched main exactly.
Two earlier full-suite pairs produced 1.546x/1.589x total-time speedups and
1.597x/1.642x average-solve speedups, so the result was repeatable rather than
a single favorable timing run.

Direct square-root distance arithmetic causes small floating-point tie
differences: average iterations were 329,223.5 versus main's 329,201.4, and
sample005 averaged 5.78 hops versus 5.74. These did not change completion or
any final region cost.

## HG07 broad-dataset check

Command in each checkout:

```sh
./benchmark.sh --dataset hg07 --concurrency 1
```

| Metric | Main | Candidate | Change |
| --- | ---: | ---: | ---: |
| Total completion time | 5.751 s | 4.600 s | 1.250x faster |
| Average solveGraph | 5.935 ms | 4.960 ms | 1.197x faster |
| P50 duration | 25.687 ms | 22.024 ms | 1.166x faster |
| P95 duration | 195.495 ms | 139.793 ms | 1.398x faster |
| Route completion | 99.8% | 99.8% | unchanged |
| Average final max-region cost | 0.263558 | 0.263558 | exact match |

All 105 per-sample statuses, completion values, and final costs matched main.
The expected sample014 input-mapping failure was present in both runs.

## Memory check

Sample008 was run through a 100 ms process-tree RSS sampler on the same host:

| Variant | Peak RSS | Duration |
| --- | ---: | ---: |
| Main | 1,656,032 KiB (1,617.22 MiB) | 7.536 s |
| Candidate | 836,272 KiB (816.67 MiB) | 5.049 s |

Measured peak RSS fell 49.5%. The two dense best-cost arrays themselves shrink
from 1,215.2 MiB to 0.50 MiB for this graph; remaining RSS is topology, solver,
dataset, runtime, and other routing state.

## Rejected trials

| Trial | Result |
| --- | --- |
| Weighted A* (`h * 2`) | Iterations fell from 1,197,418 to 738,753 and cost improved from 3.391 to 3.108, but solveGraph regressed to 9.3-10.1 s because blocker/alternate searches became much larger. |
| Two-landmark admissible topology heuristic | Hit the 2,000,004 iteration cap and took 15.834 s; final cost improved to 2.680 but the runtime regression was unacceptable. |
| Early single-layer intersection short circuit | Added branch overhead and was slower; removed. |
| Aggressive `>=` best-cost bound | Changed sample005 cost from 0.766 to 0.916; replaced with a conservative strict bound with a 1e-9 margin. |
| Compact best-cost storage alone | Delivered the memory reduction but was timing-neutral; the typed indexed frontier, early lower bound, and heap write reduction were needed for the speedup. |

## Validation

- `bunx tsc -p tsconfig.json --pretty false`: pass
- `bun test --timeout 9999999 --max-concurrency 1`: 119 pass, 0 fail
- `bun run build`: pass
- `git diff --check`: pass
- full SRJ18: 8/8 successful, 100% route completion, all costs equal to main
- full HG07: all 105 statuses, completion values, and final costs equal to main
