# /simplify review — findings to fix later

Source: review of commit `7fb0a51` (WIP: 2026-05-08), 2026-06-11.
Focus: "przemyśleć koncepcję liczenia realnych kosztów / zużycia tokenów".
4 review angles (reuse / simplification / efficiency / altitude), deduped below.

**Verdict on the cost concept itself:** the raw numbers are sound — "Kwota" reads
`win.totalCost` / `bucket.totalCost` flowing from the canonical pipeline
(`pricing.calculateCost` → `limits-analyzer` → `usage-aggregates`), and `costPct`
is computed in lib. No component re-prices tokens. The real conceptual gap is
**A1/A2 below**: there is no single owner of "effective capacity multiplier for
(timestamp, windowType)" — the diff introduced the concept but scattered it.

---

## A. Conceptual / altitude (the deep fixes)

### A1. One canonical resolver for the effective plan multiplier
- `LimitsTab.tsx:160` `getDisplayPlanMultiplier` is the only place aware of
  `theoreticalMultipliers`. Divergent, override-blind copies exist in:
  - `FiveHourTimeline.tsx:386,425` — `PLAN_TIERS[tier].multiplier / 20`
  - `PlanTab.tsx:438` — `(tierInfo?.multiplier ?? 20) / 20`
  - `src/app/api/export-windows/route.ts` — `multiplierVsMax20`
- Same window shows different "real" utilization % on Limits tab vs Timeline vs
  Plan chart as soon as a `theoreticalMultipliers` override is set.
- **Fix:** `getEffectivePlanMultiplier(plan, windowType, { normalizeToMax20 })`
  in `src/lib/plans.ts` (wrapping `getWindowTheoreticalMultiplier`), used by all
  four consumers; delete the component-local copy.

### A2. Calibration solver is blind to `theoreticalMultipliers`
- `calibration.ts:28` `scaleToMax20(value, planTier)` scales by tier multiplier
  only; calibration points captured under e.g. "Max100 with 5h ×10" get folded
  into the max20 baseline at ×5 (`solveDirectMethod`/`solveCostMethod`/
  `solveWeightedMethod`, lines ~408–410, 454, 522–525), while the UI applies ×10
  via A1's path. Solved `costLimit` and displayed `costPct` use inconsistent
  assumptions. `anomalyGroupKey` (~line 648) has the same blindness.
- **Fix:** pass an effective multiplier (not bare `PlanTier`) into
  `scaleToMax20`; resolve via `getWindowTheoreticalMultiplier` /
  `resolveLimitRegime`. Longer term: `buildCalibrationPoint` (~line 361) should
  snapshot the resolved multiplier/regime id on the `CalibrationPoint` so
  historical points stay interpretable when periods are edited.

## B. Structure of the diff (limit-insights + LimitsTab)

### B1. `LimitInsight`: 10 flat pct scalars → per-metric record
- `limit-insights.ts:27–45` + 4 transcription blocks (76–85, 129–138, 175–184,
  204–214). `estimateUtilization`/`calcUtilization` already return these as a
  struct; ~32 near-identical lines copy them out scalar-by-scalar.
  `inoutPct`/`noPromoInoutPct` have **zero consumers** (dead, write-only).
- **Fix:** `metricPct: Record<Bottleneck, number | null>` and
  `noPromoMetricPct: Record<Bottleneck, number | null>` (one adapter for the
  `ioPct`/`inoutPct` naming mismatch), rounded in one loop.

### B2. Promo epsilon 0.05 escaped into 3 UI copies
- `LimitsTab.tsx:1979, 2010, 2208–2211` re-derive `basePct - displayPct > 0.05`;
  the rule already lives in `limit-insights.ts:198–202` (`promoActive`) but only
  for the aggregate pct.
- **Fix:** named const `PROMO_PCT_EPSILON` in limit-insights; null per-metric
  `noPromo*` values when their own delta ≤ epsilon (same as the aggregate
  gating); UI condition collapses to `basePct !== null`.

### B3. Three parallel ViewMode switch helpers; one is an identity map
- `LimitsTab.tsx:1847–1863`: `viewModeBottleneck` maps each value to itself
  (`ViewMode ⊂ Bottleneck`); `viewModePct`/`viewModeNoPromoPct` become
  `insight.metricPct[viewMode]` after B1.
- **Fix:** `type ViewMode = Exclude<Bottleneck, "inout">`; delete all three.
  Also remove dead `as keyof typeof BOTTLENECK_COLORS` casts + `??` fallbacks at
  1926–1930 and 2212–2217 (records are total over `Bottleneck`).

### B4. ViewMode value selection + primary/secondary swap copy-pasted 3×
- `LimitsTab.tsx:1944–1951` (WindowRow), `2133–2142` (maxTokens),
  `2523–2536` (weekly header JSX): `output ? outputTokens : total ? totalTokens
  : totalCost` + the `formatCost`/`formatTokens` swap.
- **Fix:** `viewModeValue({outputTokens,totalTokens,totalCost}, mode)` +
  `formatViewModeValue(...) → {primary, secondary}` next to the ViewMode type.
  Rename `maxTokens` prop → `maxValue` (it holds **dollars** in cost mode —
  unit-mixing trap in the `(displayValue / maxTokens)` fallback bar).

### B5. `getDisplayPlanMultiplier` dead union + duplicated scope mapping
- `LimitsTab.tsx:160–172`: every call site now passes `PlanPeriod | null`; the
  tier-string branch is unreachable. Inline `scope === "5h" ? "5h" : "weekly"`
  duplicates `calibrationScopeToWindowType` (limit-regimes.ts:109).
- **Fix:** narrow param to `PlanPeriod | null`; body =
  `getWindowTheoreticalMultiplier(plan, calibrationScopeToWindowType(scope))`
  with one explicit default for null. (Superseded by A1 if done.)

### B6. Divergent "period has custom multipliers" + label formatting
- `PlanTab.tsx:405–416` (`periodHasCustomWindowMultiplier` +
  `formatPeriodMultipliers`) vs `LimitsTab.tsx:254–280` (`regimeMarkers`): two
  different predicates, two label formats, and **both ignore the legacy
  `theoreticalMultiplier` field** that `getWindowTheoreticalMultiplier`
  (limit-regimes.ts:113–123) treats as part of the canonical chain — a period
  configured via the legacy field shows tier defaults in PlanTab while the
  regime engine computes with the override.
- **Fix:** one `formatRegimeMultipliers(period): string | null` in
  `limit-regimes.ts` built on `getWindowTheoreticalMultiplier`; marker label via
  `planPeriodToRegime(period).label`. In PlanTab JSX (346–349) bind the result
  once per map callback (currently called twice).

## C. Efficiency (LimitsTab renders)

### C1. Per-row plan lookup moved into JSX
- `LimitsTab.tsx:2561–2565`: `getDisplayPlanMultiplier(getPlanForDate(win.startTime,
  planPeriods), ...)` per `WindowRow` per render; `getPlanForDate` does
  O(periods) `new Date()` parses. Accordion is open by default → hundreds of
  rows × every render (incl. every QuickCal keystroke — state lives in
  LimitsTab).
- **Fix:** compute per-window multiplier (+ `findCalibrationSeries`/`Anchor`)
  inside the `groups` mapping (~2232–2300) and attach to each win; keeps
  per-window resolution, restores amortization.

### C2. No memoization; insight pipeline recomputes on view-mode toggle
- The diff made `LimitInsight` viewMode-independent (that was the point of the
  per-metric fields) but never banked it: each toggle re-runs
  `computeLimitInsight` (~2× `estimateUtilization` each) for every row/bucket —
  ~1000+ identical invocations per toggle/keystroke. File has zero `useMemo`.
- **Fix:** `useMemo` the `groups` computation (deps exclude `viewMode`); pass
  precomputed insight into `WindowRow` as a prop (or memoize inside). Keep the
  cheap `maxValue` pass separate.

### C3. `regimeMarkers` micro-waste
- `LimitsTab.tsx:254–280`: `new Date(period.startDate).getTime()` re-built
  inside the `find` callback per chart point; `map` + type-guard `filter`
  repeats the marker object type.
- **Fix:** hoist `periodStartMs`; use `flatMap` (drops the type guard); store
  numeric `ts` on chart points and reuse for the sort at 252.

## D. Minor

### D1. plans route POST field whitelist vs PUT wholesale
- `src/app/api/plans/route.ts:43–52`: POST hand-copies fields (this diff is
  itself the bandaid — new fields were silently dropped); includes
  `theoreticalMultiplier` which PlanDialog never sends. PUT (line 75) stores the
  body wholesale; no single definition of a valid stored `PlanPeriod`.
- **Fix:** `normalizePlanPeriod(input, id?)` in `src/lib/plans.ts` (defaults +
  drop unknown keys + the finiteness check currently in `PlanTab.tsx:62–66`),
  used by both POST and PUT.

### D2. `buildEnsemble` patches consumer around a `0` sentinel
- `calibration.ts:607–619` skips `costLimit === 0`; root cause is
  `costLimit: 0 // not used in this method` (lines 436, 573) — `0` ambiguous
  between "unknown" and "genuinely zero"; `estimateUtilization`'s `costLim > 0`
  guard (~line 1010) is a second carve-out.
- **Fix:** `costLimit: number | null` in `SolvedLimits["methods"]`
  (types.ts:332) + generic per-dimension weighted mean that skips nulls.

---

Suggested order: B1→B3→B2 (one refactor of limit-insights + LimitsTab pickers),
then C1+C2 (same code region), then A1→A2 (the conceptual fix), then B4–B6,
D1–D2 opportunistically.
