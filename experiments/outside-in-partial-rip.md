# Outside-in partial-rip experiments

All timings are from the same Apple Silicon workstation and the committed
SRJ18 Pipeline7 inputs used by `./benchmark.sh`. Benchmark runs use the default
concurrency reported by the harness. Region-cost comparisons use the harness'
average maximum region cost.

## Acceptance target

- At least 1.5x faster than unmodified `main`.
- Prefer 5-10x if correctness and cost remain stable.
- Average maximum region cost no more than roughly 20% above the original
  score (2.333), i.e. at most about 2.800.
- All 8 SRJ18 cases and all 2,001 routes must complete.

## Trial 0 - unmodified main (`b617b67`)

Command: `./benchmark.sh`

- Result directory: `results/run001`
- Success: 8/8 cases, 2,001/2,001 routes.
- Total completion time: 95.441 s.
- Average duration: 11.930 s; P50 11.000 s; P95 18.759 s.
- Average maximum region cost: 2.333.
- Average solver iterations: 1,335,770.1.
- Per-case duration: 8.129, 5.359, 6.061, 15.945, 12.904, 11.000,
  17.283, and 18.759 s.

The solver performs ten full-graph rerips on these committed inputs. A focused
sample001 diagnostic measured 1,390,418 iterations, 10 rerips, and 8.049 s.

## Diagnostic - accept the first complete route set

This was a read-only parameter probe (`RIP_THRESHOLD_RAMP_ATTEMPTS=0`), not an
implementation trial. It establishes the optimization ceiling by removing all
post-solve rerips while leaving initial routing unchanged.

- Aggregate solve time across all eight cases: 7.285 s (13.10x faster).
- Average maximum region cost: 1.910 (18.1% better than the main baseline).
- All eight cases completed.

This confirms that repeated whole-trace rerouting is both the dominant runtime
cost and unnecessary for preserving the benchmark's region-cost envelope.

## Trial 1 - bounded central partial rip (12 mm per retained end)

Implementation: retain every unaffected prefix/suffix, select the hottest
segment on each affected route, reopen at most 12 mm of its old path on either
side, and route only between the resulting temporary endpoints. Restore the
best completed state at termination.

Command: `./benchmark.sh`

- Success: 8/8 cases, 2,001/2,001 routes.
- Total completion time: 48.460 s (1.97x faster).
- Average duration: 6.057 s; P50 4.497 s; P95 14.112 s.
- Average maximum region cost: 1.701 (27.1% better than main).
- Average solver iterations: 676,204.1 (49.4% fewer than main).
- Per-case duration: 3.335, 3.053, 2.141, 8.779, 14.112, 4.497,
  7.229, and 5.314 s.

This clears the minimum speed target with substantial aggregate cost headroom.
The remaining issues are sample008 reaching its two-million-iteration cap and
sample011 ending at 5.117 versus main's 3.217. The next trials target those two
tails and add the required two-ended search.

## Trial 2 - outside-in partial spans, 24 post-meeting expansions

Implementation: initial whole routes retain the established one-ended A* for
quality. Every partially reopened span receives two independent frontiers, one
from each retained end. Each frontier has a hard 24 mm travel limit. Once the
frontiers meet, the solver considers 24 additional expansions and commits the
lowest-cost valid join. A span that cannot meet within the bound falls back to
the regular route search. Live region caches are canonicalized to the same
route order used during output replay, eliminating score drift after
serialization.

Command: `./benchmark.sh`

- Success: 8/8 cases, 2,001/2,001 routes.
- Total completion time: 17.792 s (5.36x faster).
- Average duration: 2.224 s; P50 1.707 s; P95 5.166 s.
- Average maximum region cost: 1.488 (36.2% better than main).
- Average solver iterations: 260,978.9 (80.5% fewer than main).
- Per-case duration: 1.389, 0.926, 0.788, 2.745, 5.166, 1.707,
  1.924, and 3.146 s.
- Per-case max cost: 1.237, 1.543, 0.797, 1.133, 2.834, 1.492,
  1.278, and 1.590.

This reaches the requested 5-10x range while improving the aggregate region
score. Focused sample008 and sample011 checks also eliminated Trial 1's cost
tails (2.834 and 1.590 respectively).

## Trial 3 - reduce post-meeting search from 24 to 16 (rejected)

Focused command: `./benchmark.sh --sample NAME --concurrency 1` for samples
001, 007, 008, and 011.

- sample001: 2.938 s, cost 1.375, 453,560 iterations.
- sample007: 3.140 s, cost 1.133, 220,971 iterations.
- sample008: 10.138 s, cost 3.285, 1,567,708 iterations.
- sample011: 3.594 s, cost 1.835, 367,853 iterations.

Although each individual join did less work, the weaker join choices caused
substantially more work in later partial-rip rounds. Reverted to 24.

## Trial 4 - raise per-frontier travel limit from 24 mm to 32 mm (rejected)

The same four focused cases produced identical costs and iteration counts to
Trial 2. No selected route needed the additional frontier reach; elapsed time
was slightly noisier/slower. Reverted to 24 mm.

## Trial 5 - partial-rip window sweep (8, 14, and 16 mm; rejected)

Focused samples 001/007/008/011 were run at each distance.

- 8 mm was faster on some cases but regressed costs to 3.130 on sample001 and
  3.400 on sample008.
- 14 mm regressed sample001 to 1.746 and sample008 to 3.400.
- 16 mm improved costs (0.963/0.764/2.224/1.590) but increased the four-case
  iteration total by roughly 24% versus 12 mm and dropped the projected suite
  speed below the requested 5x range.

The 12 mm window remains the best speed/quality balance.

## Trial 6 - cap partial-rip exploration at six rounds (accepted)

Command: `./benchmark.sh`

- Success: 8/8 cases, 2,001/2,001 routes.
- Total completion time: 16.871 s (5.66x faster).
- Average duration: 2.109 s; P50 1.598 s; P95 4.065 s.
- Average maximum region cost: 1.530 (34.4% better than main and 45.4%
  below the allowed 2.800 aggregate ceiling).
- Average solver iterations: 219,249.0 (83.6% fewer than main).
- Per-case duration: 1.387, 1.598, 0.858, 2.495, 4.065, 1.456,
  1.741, and 3.271 s.
- Per-case max cost: 1.237, 1.543, 0.797, 1.133, 3.313, 1.267,
  1.359, and 1.590.

The sample008 score is 18.1% above its original 2.806 and therefore remains
inside the requested per-case tolerance as well as the aggregate tolerance.

## Trial 7 - cap partial-rip exploration at five rounds (rejected)

Focused samples were slightly faster, but sample001 regressed to 1.461, 33.9%
above its original 1.091 score. Reverted to six rounds.

## Trial 8 - bounded connector distance (accepted aggregate setting)

Added an explicit combined-distance check to ensure that a joined path can be
split between the two frontiers without either side exceeding its 24 mm travel
budget. A deliberately over-budget regression fixture confirms that the solver
falls back safely to its established one-ended search.

Command: `./benchmark.sh`

- Success: 8/8 cases, 2,001/2,001 routes.
- Total completion time: 15.725 s (6.07x faster than main's 95.441 s).
- Average duration: 1.966 s; P50 1.396 s; P95 4.138 s.
- Average maximum region cost: 1.530 (34.4% better than main's 2.333 and
  45.4% below the allowed 2.800 aggregate ceiling).
- Average solver iterations: 219,249.0 (83.6% fewer than main's 1,335,770.1).
- Per-case duration: 1.376, 1.396, 0.687, 2.416, 4.138, 1.273,
  1.534, and 2.906 s.
- Per-case max cost: 1.237, 1.543, 0.797, 1.133, 3.313, 1.267,
  1.359, and 1.590.

Verification: `bun run typecheck`, `bun run build`, `git diff --check`, and
all 100 non-image-snapshot tests pass. The repository's three image-snapshot
files remain unavailable in this environment because the pre-existing optional
Sharp Darwin ARM64 native binary is absent; the failures occur while importing
the snapshot helper, before solver code executes.

## Trial 9 - strict per-case quality sweep

Although Trial 8 exceeded the aggregate quality target, sample007's 1.133 cost
was more than 20% above its original 0.527. Additional focused trials treated
the tolerance as a per-case requirement:

- Fixed 20 mm partial windows: sample007 cost 0.838 in 2.682 s.
- Fixed 24 mm partial windows: sample007 cost 0.775 in 2.877 s.
- Fixed 32 mm partial windows: sample007 cost 0.834 in 3.016 s (rejected).
- Fixed 24 mm windows with ten rounds: sample007 cost 0.629 in 3.121 s,
  inside its 0.632 tolerance ceiling. Across the suite this took 21.294 s
  (4.48x faster) and averaged 1.404, but sample001 regressed to 1.685, so the
  fixed setting was rejected.
- Staging 12 mm windows before switching to 24 mm preserved sample001 but left
  sample007 between 0.717 and 0.730, outside its strict ceiling (rejected).

The useful signal was the first completed solution's relationship to the final
rip threshold: sample007 begins near the target and needs a wider repair from
the first round, while highly congested cases benefit from local repairs.

## Final verification - threshold-relative quality recovery

Implementation: latch a 24 mm quality-recovery window when the first completed
solution's maximum hot-region cost is no more than 1.5 times the configured
final rip threshold. Otherwise retain the fast 12 mm window. Both modes use at
most ten partial-rip rounds and always restore the best complete snapshot.

Command: `./benchmark.sh`

- Success: 8/8 cases, 2,001/2,001 routes.
- Total completion time: 18.717 s (5.10x faster than main's 95.441 s).
- Average duration: 2.340 s; P50 1.473 s; P95 5.364 s.
- Average maximum region cost: 1.425 (38.9% better than main's 2.333).
- Average solver iterations: 270,910.0 (79.7% fewer than main's 1,335,770.1).
- Per-case duration: 1.465, 0.984, 1.021, 3.369, 5.364, 1.473,
  1.716, and 3.326 s.

| Sample | Original cost | Final cost | Change |
| --- | ---: | ---: | ---: |
| sample001 | 1.091 | 1.237 | +13.4% |
| sample003 | 6.353 | 1.543 | -75.7% |
| sample005 | 1.492 | 0.797 | -46.6% |
| sample007 | 0.527 | 0.629 | +19.4% |
| sample008 | 2.806 | 2.834 | +1.0% |
| sample009 | 1.492 | 1.492 | 0.0% |
| sample010 | 1.686 | 1.278 | -24.2% |
| sample011 | 3.217 | 1.590 | -50.6% |

Every case is now within 20% of its own original score or better, in addition
to the stronger aggregate result.

Verification: `bun run typecheck`, `bun run build`, `git diff --check`, and all
101 non-image-snapshot tests pass. As noted in Trial 8, the three remaining
snapshot files cannot import their pre-existing optional Sharp native binary in
this environment; they fail before any solver code runs.

## Trial 10 - end-to-end topology canary and live-cache scoring

The package benchmark alone hid an important downstream effect. On SRJ18
sample005, the original implementation reduced solve-graph time from 8.08 s to
1.58 s, but increased `HighDensitySolver` work from 27,363 to 53,632 iterations
and end-to-end time from 26.58 s to 35.80 s.

Diagnostics with zero, one, and two partial rounds all produced the same
53,632-iteration detailed route. Removing canonical route-order cache replay
and retaining the live candidate costs exposed a useful ten-round progression:

- round 0: max cost 0.797, 1,129 segments;
- round 1: max cost 0.923, 1,029 segments;
- round 2: max cost 0.960, 992 segments;
- round 3: max cost 0.766, 988 segments.

The temporary cost valley is necessary. Restoring round three reduced the
direct end-to-end canary to 15.78 s and solve-graph time to 1.17 s. Fixed caps
were rejected because they also changed the rip-threshold ramp; candidate
selection and stopping must remain separate.

## Trial 11 - cross-dataset global reseed count

SRJ19 samples 12,13,35,42,46,48,54,55,79,81,83,97,98,99,100 were used as a
regression-heavy set with four workers and a deliberately short 90 s cap.

- main: 12/15 complete, 0/15 relaxed DRC, 67.8 s solved-case P50;
- partial only: 6/15 complete, 4/15 DRC, 25.5 s P50;
- one whole-graph warmup then partial: 8/15 complete, 5/15 DRC, 23.8 s P50;
- two whole-graph warmups then partial: 8/15 complete, 2/15 DRC, 25.1 s P50.

One global warmup was accepted. It gives partial routing a different topology
basin without repeatedly discarding every completed trace. A second warmup
loses three DRC passes.

## Trial 12 - density-aware candidate selection (rejected as a selector)

Peak regional segment count and sum-of-squared regional segment count correlate
with detailed-routing difficulty. A strict density guard recovered SRJ19
sample083 at the 90 s cap, but changed sample079 from a 5.1 s DRC pass into a
13.1 s DRC failure. Squared-density-first selection improved the SRJ19 stress
set to 6/15 DRC and a 22.0 s P50, but reduced SRJ20 DRC.

On the SRJ20 stress set (samples 6,10,13,14,20,28,29,30,35,38,41,53,62,63,75):

- main: 11/15 complete, 3/15 DRC, 12.5 s P50;
- region-cost-first partial routing: 11/15 complete, 5/15 DRC, 23.1 s P50;
- squared-density-first full horizon: 11/15 complete, 3/15 DRC, 23.2 s P50.

Density metrics remain in solver and benchmark telemetry, but final candidate
selection is region-cost-first on medium graphs. The result is a 54.3% average
max-cost improvement from the first completed SRJ20 solution (6.736 to 3.079).

## Trial 13 - scale-aware policy and preloaded guard

A single selection policy was not universal. The accepted integration uses
three regimes:

- fewer than 20 routes: use the established solver unchanged;
- 20-99 routes: one global warmup, then ten bounded partial rounds, restoring
  the best region-cost state;
- at least 100 routes: allow segment count to break ties inside a 20% max-cost
  and 10% total-cost envelope, with an optional 2% quality target.

The large-graph mode reproduces the better SRJ18 downstream topology: all eight
expected completion cases solve, 4/8 pass relaxed DRC, P50 is 24.4 s, and
sample016 is recovered. Across those cases, max region cost improves 39.7% from
the first completed state. On seven cases shared with main, every case is
faster and the paired median is approximately 1.50x faster.

Small dataset01 cases remain neutral. SRJ21 (8-16 routes) exactly reproduces
main at 10/10 completion and 9/10 DRC. Representative SRJ23 preloaded cases also
remain on the established behavior: serialized trace occupancy explicitly
disables partial rip and outside-in reconnection.

## Final cross-dataset verification

Command: `./benchmark.sh`

- Success: 8/8 cases, 2,001/2,001 routes.
- Total completion time: 21.773 s (4.38x faster than main's 95.441 s).
- Average maximum region cost: 1.739 (25.5% better than main's 2.333).
- P50 duration: 1.611 s; P95 duration: 7.660 s.
- Average solver iterations: 329,201.4 (75.4% fewer than main).

Verification: `bun run typecheck`, `bun run build`, the seven focused
outside-in/partial-rip tests, and `git diff --check` pass. The full suite runs
104 passing assertions; its three image-test modules still fail to import the
workspace's missing optional Sharp Darwin ARM64 binary before their assertions
execute.

## Trial 14 - zero-overhead compatibility path

The first hosted SRJ21 run preserved completion, DRC, and routing output but
reported a higher wall-clock P50 than the stored main run. Profiling the gated
path showed that partial-rip bookkeeping was still performed on every completed
route even when both partial rip and outside-in routing were disabled.

Fast exits now bypass partial-plan map lookups and stats publication in
`getRouteStartPortId`, `getRouteEndPortId`, `getStartingNextRegionId`,
`computeH`, `onPathFound`, and `resetRoutingStateForRerip` when the feature is
gated off. A controlled back-to-back SRJ21 run against the preceding commit
kept the exact 10/10 completion and 9/10 DRC result while reducing aggregate
runtime from 5.704 s to 5.374 s (1.06x) and improving the paired median by
1.07x. Every one of the ten samples was faster.

The package benchmark remained 8/8 solved with the same 1.739 average maximum
region cost and completed in 20.632 s (4.63x faster than main's 95.441 s).

## Trial 15 - full-holdout scale bounds

The first hosted autorouter `/benchmark-all` run confirmed the large-graph win
but exposed that the 20-route activation boundary was too broad:

- dataset01: 100% completion, 91.8% DRC versus 90.6% on main, and 6.5 s P50
  versus 7.0 s;
- SRJ18: 56.3% completion versus 50.0%, equal 25.0% DRC, and 83.4 s P50
  versus 144.4 s;
- SRJ19: 78.5% completion versus 82.5% and 35.0% DRC versus 37.0%;
- SRJ21 and preloaded SRJ23 preserve their completion and DRC rates exactly.

SRJ19 telemetry showed that all 13 completion regressions had 41-59 routes. An
intermediate minimum of 60 restored those graphs while retaining the 61-route
sample068 completion/DRC gain, where partial ripping improves max region cost
from 11.148 to 2.401 and total region cost from 48.803 to 24.171. The full
SRJ20 holdout then showed 67.0% completion versus 70.0% on main (with 31.0%
versus 30.5% DRC); its last remaining completion regression had 62 routes.
The final 100-route boundary cleanly preserves the medium datasets while every
SRJ18 graph remains eligible (the smallest has 114 routes).

The SRJ18 sample008 holdout (361 routes) also showed that partial candidates
could not satisfy the total-cost envelope. Bypassing partial routing above 350
routes improved its selected max region cost from 3.400 to 2.244, reduced the
squared region-segment count from 10,628 to 7,437, and cut a controlled local
end-to-end run from 182.7 s to 93.1 s while restoring the main-like 299-via
topology. The accepted integration therefore enables partial routing only for
100-350 routes, with both bounds configurable.
