"use client";

import { Fragment, useMemo, useState } from "react";
import { CalibrationPoint, CalibrationScope, PLAN_TIERS, PlanPeriod } from "@/lib/types";
import { formatTokens, formatCost, formatDateTime } from "@/lib/format";
import { getModelPricing } from "@/lib/pricing";
import { getPlanTierForDate } from "@/lib/plans";

interface Props {
  calibrations: CalibrationPoint[];
  loading?: boolean;
  planPeriods?: PlanPeriod[];
}

type ScopeFilter = "weekly-all" | "weekly-sonnet" | "5h";

interface ModelDelta {
  model: string;
  deltaCost: number;
  deltaInput: number;
  deltaOutput: number;
  deltaCacheW: number;
  deltaCacheR: number;
  deltaTotal: number;
  deltaInputCost: number;
  deltaOutputCost: number;
  deltaCacheWCost: number;
  deltaCacheRCost: number;
}

interface DeltaRow {
  fromPct: number;
  toPct: number;
  deltaPct: number;
  fromTime: string;
  toTime: string;
  deltaCost: number;
  rawCostPerPct: number;
  normalizedCostPerPct: number;
  deltaOutput: number;
  outputPerPct: number;
  deltaInput: number;
  inputPerPct: number;
  deltaTotal: number;
  totalPerPct: number;
  deltaCacheW: number;
  deltaCacheR: number;
  deltaInputCost: number;
  deltaOutputCost: number;
  deltaCacheWCost: number;
  deltaCacheRCost: number;
  minutesBetween: number;
  modelDeltas: ModelDelta[];
}

interface WeekGroupTotals {
  totalDeltaPct: number;
  totalDeltaCost: number;
  totalDeltaOutput: number;
  totalDeltaInput: number;
  totalDeltaCacheW: number;
  totalDeltaCacheR: number;
  totalDeltaTotal: number;
  totalDeltaInputCost: number;
  totalDeltaOutputCost: number;
  totalDeltaCacheWCost: number;
  totalDeltaCacheRCost: number;
  totalMinutes: number;
  avgRawCostPerPct: number;
  avgCostPerPct: number;
  avgOutputPerPct: number;
  avgInputPerPct: number;
  avgCacheWPerPct: number;
  avgCacheRPerPct: number;
  avgTotalPerPct: number;
  estCost100: number;
  estOutput100: number;
  estTotal100: number;
}

interface WeekGroup {
  weekLabel: string;
  weekStart: string;
  pointCount: number;
  planLabel: string | null;
  planShortLabel: string | null;
  planColor: string;
  hasPromoAdjustedPoints: boolean;
  rows: DeltaRow[];
  totalDeltaPct: number;
  avgRawCostPerPct: number;
  avgCostPerPct: number;
  avgOutputPerPct: number;
  avgTotalPerPct: number;
  totals: WeekGroupTotals;
}

function getGroupLabel(iso: string, scope: ScopeFilter): string {
  const d = new Date(iso);
  if (scope === "5h") {
    return d.toLocaleDateString("pl-PL", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString("pl-PL", { day: "2-digit", month: "short" });
}

/** Format tokens / $cost in one cell */
function fmtTC(tokens: number, cost: number): string {
  return `${formatTokens(tokens)} / ${formatCost(cost)}`;
}

const SCOPE_TABS: { key: ScopeFilter; label: string }[] = [
  { key: "weekly-all", label: "Weekly ALL" },
  { key: "weekly-sonnet", label: "Weekly Sonnet" },
  { key: "5h", label: "5h Windows" },
];

const EMPTY_PLAN_PERIODS: PlanPeriod[] = [];

export function CalibrationDeltaTable({ calibrations, loading, planPeriods = EMPTY_PLAN_PERIODS }: Props) {
  const [scope, setScope] = useState<ScopeFilter>("weekly-all");
  const [minDelta, setMinDelta] = useState(0);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [summaryOnly, setSummaryOnly] = useState(false);

  const toggleRow = (key: string) =>
    setExpandedRows((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const weekGroups = useMemo((): WeekGroup[] => {
    const points = calibrations
      .filter(
        (p) =>
          p.scope === scope &&
          p.reportedPct >= 0 &&
          p.normalizedTokens != null
      )
      .sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

    // Group by period: weekly → by week start date, 5h → by windowStart (full timestamp)
    const grouped = new Map<string, CalibrationPoint[]>();
    for (const p of points) {
      const key =
        scope === "5h"
          ? p.windowStart ?? "unknown"
          : p.windowStart?.substring(0, 10) ?? "unknown";
      const arr = grouped.get(key) ?? [];
      arr.push(p);
      grouped.set(key, arr);
    }

    const result: WeekGroup[] = [];

    for (const [weekStart, pts] of grouped) {
      if (pts.length < 2) continue;

      const rows: DeltaRow[] = [];
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const curr = pts[i];
        const deltaPct = curr.reportedPct - prev.reportedPct;
        if (deltaPct <= 0) continue;
        if (deltaPct < minDelta) continue;

        const n1 = prev.normalizedTokens!;
        const n2 = curr.normalizedTokens!;
        const rawDeltaCost = curr.cost - prev.cost;
        const deltaCost = n2.cost - n1.cost;
        const deltaOutput = n2.output - n1.output;
        const deltaInput = n2.input - n1.input;
        const deltaTotal = n2.total - n1.total;
        const deltaCacheW = n2.cacheWrite - n1.cacheWrite;
        const deltaCacheR = n2.cacheRead - n1.cacheRead;
        const minutesBetween = Math.round(
          (new Date(curr.timestamp).getTime() -
            new Date(prev.timestamp).getTime()) /
            60000
        );

        // Model deltas from modelBreakdown (if both points have it)
        const modelDeltas: ModelDelta[] = [];
        let aggInputCost = 0;
        let aggOutputCost = 0;
        let aggCacheWCost = 0;
        let aggCacheRCost = 0;

        if (prev.modelBreakdown && curr.modelBreakdown) {
          const allModels = new Set([
            ...Object.keys(prev.modelBreakdown),
            ...Object.keys(curr.modelBreakdown),
          ]);
          for (const model of allModels) {
            const m1 = prev.modelBreakdown[model];
            const m2 = curr.modelBreakdown[model];
            const dCost = (m2?.totalCost ?? 0) - (m1?.totalCost ?? 0);
            const dIn = (m2?.inputTokens ?? 0) - (m1?.inputTokens ?? 0);
            const dOut = (m2?.outputTokens ?? 0) - (m1?.outputTokens ?? 0);
            const dCW = (m2?.cacheCreationTokens ?? 0) - (m1?.cacheCreationTokens ?? 0);
            const dCR = (m2?.cacheReadTokens ?? 0) - (m1?.cacheReadTokens ?? 0);
            const dTot = (m2?.totalTokens ?? 0) - (m1?.totalTokens ?? 0);

            // Per-type costs from model pricing
            const pricing = getModelPricing(model);
            const dInCost = (dIn / 1_000_000) * pricing.input;
            const dOutCost = (dOut / 1_000_000) * pricing.output;
            const dCWCost = (dCW / 1_000_000) * pricing.cache1hWrite;
            const dCRCost = (dCR / 1_000_000) * pricing.cacheRead;

            aggInputCost += dInCost;
            aggOutputCost += dOutCost;
            aggCacheWCost += dCWCost;
            aggCacheRCost += dCRCost;

            if (dCost !== 0 || dOut !== 0 || dTot !== 0) {
              modelDeltas.push({
                model, deltaCost: dCost,
                deltaInput: dIn, deltaOutput: dOut, deltaCacheW: dCW, deltaCacheR: dCR, deltaTotal: dTot,
                deltaInputCost: dInCost, deltaOutputCost: dOutCost, deltaCacheWCost: dCWCost, deltaCacheRCost: dCRCost,
              });
            }
          }
          modelDeltas.sort((a, b) => b.deltaCost - a.deltaCost);
        }

        rows.push({
          fromPct: prev.reportedPct,
          toPct: curr.reportedPct,
          deltaPct,
          fromTime: prev.timestamp,
          toTime: curr.timestamp,
          deltaCost,
          rawCostPerPct: rawDeltaCost / deltaPct,
          normalizedCostPerPct: deltaCost / deltaPct,
          deltaOutput,
          outputPerPct: deltaOutput / deltaPct,
          deltaInput,
          inputPerPct: deltaInput / deltaPct,
          deltaTotal,
          totalPerPct: deltaTotal / deltaPct,
          deltaCacheW,
          deltaCacheR,
          deltaInputCost: aggInputCost,
          deltaOutputCost: aggOutputCost,
          deltaCacheWCost: aggCacheWCost,
          deltaCacheRCost: aggCacheRCost,
          minutesBetween,
          modelDeltas,
        });
      }

      if (rows.length === 0) continue;

      const validRows = rows.filter(
        (r) => r.deltaCost > 0 || r.rawCostPerPct > 0 || r.normalizedCostPerPct > 0
      );
      const totalDelta = rows.reduce((s, r) => s + r.deltaPct, 0);
      const weightedRawCost = validRows.reduce(
        (s, r) => s + r.rawCostPerPct * r.deltaPct,
        0
      );
      const weightedCost = validRows.reduce(
        (s, r) => s + r.normalizedCostPerPct * r.deltaPct,
        0
      );
      const weightedOut = validRows.reduce(
        (s, r) => s + r.outputPerPct * r.deltaPct,
        0
      );
      const weightedTot = validRows.reduce(
        (s, r) => s + r.totalPerPct * r.deltaPct,
        0
      );
      const validDelta = validRows.reduce((s, r) => s + r.deltaPct, 0);

      // Build aggregate totals for the group
      const sumCost = validRows.reduce((s, r) => s + r.deltaCost, 0);
      const sumOutput = validRows.reduce((s, r) => s + r.deltaOutput, 0);
      const sumInput = validRows.reduce((s, r) => s + r.deltaInput, 0);
      const sumCacheW = validRows.reduce((s, r) => s + r.deltaCacheW, 0);
      const sumCacheR = validRows.reduce((s, r) => s + r.deltaCacheR, 0);
      const sumTotal = validRows.reduce((s, r) => s + r.deltaTotal, 0);
      const sumInputCost = validRows.reduce((s, r) => s + r.deltaInputCost, 0);
      const sumOutputCost = validRows.reduce((s, r) => s + r.deltaOutputCost, 0);
      const sumCacheWCost = validRows.reduce((s, r) => s + r.deltaCacheWCost, 0);
      const sumCacheRCost = validRows.reduce((s, r) => s + r.deltaCacheRCost, 0);
      const sumMinutes = rows.reduce((s, r) => s + r.minutesBetween, 0);
      const avgRawCPP = validDelta > 0 ? weightedRawCost / validDelta : 0;
      const avgCPP = validDelta > 0 ? weightedCost / validDelta : 0;
      const avgOPP = validDelta > 0 ? weightedOut / validDelta : 0;

      const totals: WeekGroupTotals = {
        totalDeltaPct: totalDelta,
        totalDeltaCost: sumCost,
        totalDeltaOutput: sumOutput,
        totalDeltaInput: sumInput,
        totalDeltaCacheW: sumCacheW,
        totalDeltaCacheR: sumCacheR,
        totalDeltaTotal: sumTotal,
        totalDeltaInputCost: sumInputCost,
        totalDeltaOutputCost: sumOutputCost,
        totalDeltaCacheWCost: sumCacheWCost,
        totalDeltaCacheRCost: sumCacheRCost,
        totalMinutes: sumMinutes,
        avgRawCostPerPct: avgRawCPP,
        avgCostPerPct: avgCPP,
        avgOutputPerPct: avgOPP,
        avgInputPerPct: validDelta > 0 ? sumInput / validDelta : 0,
        avgCacheWPerPct: validDelta > 0 ? sumCacheW / validDelta : 0,
        avgCacheRPerPct: validDelta > 0 ? sumCacheR / validDelta : 0,
        avgTotalPerPct: validDelta > 0 ? weightedTot / validDelta : 0,
        estCost100: avgCPP * 100,
        estOutput100: avgOPP * 100,
        estTotal100: validDelta > 0 ? (weightedTot / validDelta) * 100 : 0,
      };

      const planTier =
        planPeriods.length > 0
          ? getPlanTierForDate(pts[0].windowStart ?? pts[0].timestamp, planPeriods)
          : null;
      const planInfo = planTier ? PLAN_TIERS[planTier] : null;
      const hasPromoAdjustedPoints = pts.some(
        (p) => p.normalizedTokens != null && p.cost - p.normalizedTokens.cost > 1e-6
      );

      result.push({
        weekLabel: getGroupLabel(weekStart, scope),
        weekStart,
        pointCount: pts.length,
        planLabel: planInfo?.label ?? null,
        planShortLabel: planInfo?.shortLabel ?? null,
        planColor: planInfo?.color ?? "var(--text-muted)",
        hasPromoAdjustedPoints,
        rows,
        totalDeltaPct: totalDelta,
        avgRawCostPerPct: avgRawCPP,
        avgCostPerPct: avgCPP,
        avgOutputPerPct: avgOPP,
        avgTotalPerPct: totals.avgTotalPerPct,
        totals,
      });
    }

    return result.sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  }, [calibrations, minDelta, planPeriods, scope]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Calibration Δ Analysis
          </h3>
          <p className="text-[10px] text-[var(--text-muted)]">
            `Δ%` pokazuje zmianę `Observed %` między kolejnymi snapshotami Anthropic w tym
            samym oknie lub tygodniu. `Norm $/1%` jest liczone w bazie `1x / no promo`,
            czyli po zdjęciu wpływu promo z usage. `Raw $/1%` zostaje na realnym spendzie.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setSummaryOnly((v) => !v)}
            className={`text-[10px] px-2 py-1 rounded border transition-all font-medium ${
              summaryOnly
                ? "bg-[var(--accent-purple)]/15 text-[var(--accent-purple)] border-[var(--accent-purple)]/40"
                : "bg-[var(--bg-secondary)] text-[var(--text-muted)] border-[var(--border-subtle)] hover:text-[var(--text-secondary)]"
            }`}
            title="Pokaż tylko wiersze Σ (sumy okresów)"
          >
            Σ only
          </button>
          <select
            value={minDelta}
            onChange={(e) => setMinDelta(Number(e.target.value))}
            className="text-[10px] px-2 py-1 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)] border border-[var(--border-subtle)]"
          >
            <option value={0}>All Δ%</option>
            <option value={2}>Δ% ≥ 2</option>
            <option value={3}>Δ% ≥ 3</option>
            <option value={5}>Δ% ≥ 5</option>
          </select>
        </div>
      </div>

      <div className="flex gap-1 bg-[var(--bg-secondary)] rounded-md p-0.5 w-fit">
        {SCOPE_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setScope(key)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${
              scope === key
                ? "bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="card p-4 space-y-4">

      {loading ? (
        <div className="space-y-3 animate-pulse">
          <div className="flex items-center gap-3">
            <div className="h-3 w-20 bg-[var(--bg-secondary)] rounded" />
            <div className="h-3 w-32 bg-[var(--bg-secondary)] rounded" />
          </div>
          {[0, 1, 2, 3].map((skeletonRow) => (
            <div key={`skeleton-${skeletonRow}`} className="flex gap-2">
              <div className="h-3 w-24 bg-[var(--bg-secondary)] rounded" />
              <div className="h-3 w-12 bg-[var(--bg-secondary)] rounded" />
              <div className="h-3 w-16 bg-[var(--bg-secondary)] rounded" />
              <div className="h-3 w-20 bg-[var(--bg-secondary)] rounded" />
              <div className="h-3 w-14 bg-[var(--bg-secondary)] rounded" />
            </div>
          ))}
          <p className="text-[10px] text-[var(--text-muted)]">Ładowanie kalibracji...</p>
        </div>
      ) : weekGroups.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          Brak danych — potrzeba min. 2 kalibracje w tym samym oknie lub tygodniu.
        </p>
      ) : (
        weekGroups.map((week) => (
          <div key={week.weekStart} className="space-y-1">
            <div className="flex items-center gap-3 py-1">
              <span className="text-xs font-semibold text-[var(--text-primary)]">
                {week.weekLabel}
              </span>
              {week.planShortLabel && (
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                  style={{
                    color: week.planColor,
                    background: `color-mix(in srgb, ${week.planColor} 14%, transparent)`,
                  }}
                  title={week.planLabel ?? undefined}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: week.planColor }}
                  />
                  {week.planShortLabel}
                </span>
              )}
              <span className="text-[10px] px-2 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-muted)]">
                base 1x / no promo
              </span>
              {week.hasPromoAdjustedPoints && (
                <span className="text-[10px] px-2 py-0.5 rounded bg-[var(--accent-orange)]/12 text-[var(--accent-orange)]">
                  includes promo-adjusted points
                </span>
              )}
              <span className="text-[10px] text-[var(--text-muted)]">
                {week.pointCount} cal · Obs Δ{week.totalDeltaPct}% covered
              </span>
              {week.avgCostPerPct > 0 && (
                <>
                  <span className="text-[10px] text-[var(--accent-green)] font-medium">
                    avg raw {formatCost(week.avgRawCostPerPct)}/1%
                  </span>
                  <span className="text-[10px] text-[var(--text-muted)]">
                    ·
                  </span>
                  <span className="text-[10px] text-[var(--accent-green)] font-medium">
                    avg norm {formatCost(week.avgCostPerPct)}/1%
                  </span>
                  <span className="text-[10px] text-[var(--text-muted)]">
                    →
                  </span>
                  <span className="text-[10px] text-[var(--accent-green)] font-medium">
                    est. {formatCost(week.avgCostPerPct * 100)} norm @100%
                  </span>
                </>
              )}
              {week.avgOutputPerPct > 0 && (
                <span className="text-[10px] text-[var(--text-muted)]">
                  out {formatTokens(week.avgOutputPerPct)}/1% → {formatTokens(week.avgOutputPerPct * 100)} @100%
                </span>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <colgroup>
                  {/* Delta: Range, Δ%, Δ Cost */}
                  <col />
                  <col />
                  <col />
                  {/* Δ Tokens: All, In, Out, CW, CR */}
                  <col className="border-l border-[var(--border-subtle)]" />
                  <col />
                  <col />
                  <col />
                  <col />
                  {/* Per 1%: Raw $/1%, Norm $/1%, In, Out, CW, CR, Tot */}
                  <col className="border-l border-[var(--border-subtle)]" />
                  <col />
                  <col />
                  <col />
                  <col />
                  <col />
                  <col />
                  {/* Est 100%: Cost, Output, Total */}
                  <col className="border-l border-[var(--border-subtle)]" />
                  <col />
                  <col />
                  {/* Time */}
                  <col />
                </colgroup>
                <thead>
                  <tr className="text-[9px] uppercase tracking-wider">
                    <th colSpan={3} className="text-left py-0.5 px-1.5 text-[var(--text-muted)] font-normal">
                      Observed Δ
                    </th>
                    <th colSpan={5} className="text-left py-0.5 px-1.5 text-[var(--text-muted)] font-normal border-l border-[var(--border-subtle)]">
                      Δ Tokens
                    </th>
                    <th colSpan={7} className="text-left py-0.5 px-1.5 text-[var(--text-muted)] font-normal border-l border-[var(--border-subtle)]">
                      Per 1% (base)
                    </th>
                    <th colSpan={3} className="text-left py-0.5 px-1.5 text-[var(--text-muted)] font-normal border-l border-[var(--border-subtle)]">
                      Est. 100% limit (no promo)
                    </th>
                    <th />
                  </tr>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="text-left py-1 px-1.5 text-[var(--text-muted)] font-medium">Observed</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Obs Δ%</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Norm Δ $</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium border-l border-[var(--border-subtle)]">All</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">In</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Out</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">CacheW</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">CacheR</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium border-l border-[var(--border-subtle)]">Raw $/1%</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Norm $/1%</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">In/1%</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Out/1%</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">CW/1%</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">CR/1%</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Tot/1%</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium border-l border-[var(--border-subtle)]">Norm Cost</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Output</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Total</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {!summaryOnly && week.rows.map((row, idx) => {
                    const isZero = row.deltaCost <= 0;
                    const rowKey = `${week.weekStart}-${idx}`;
                    const hasModels = row.modelDeltas.length > 0;
                    const isExpanded = expandedRows.has(rowKey);
                    return (
                      <Fragment key={rowKey}>
                        <tr
                          className={`border-b border-[var(--border-subtle)] ${
                            isZero ? "opacity-30" : ""
                          } ${hasModels && !isZero ? "cursor-pointer hover:bg-[var(--bg-secondary)]" : ""}`}
                          onClick={hasModels && !isZero ? () => toggleRow(rowKey) : undefined}
                        >
                          {/* Delta */}
                          <td className="py-1 px-1.5 text-[var(--text-secondary)] whitespace-nowrap">
                            {hasModels && !isZero && (
                              <span className="inline-block w-3 text-[9px] text-[var(--text-muted)]">
                                {isExpanded ? "▾" : "▸"}
                              </span>
                            )}
                            {row.fromPct}% → {row.toPct}%
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums font-medium text-[var(--accent-purple)]">
                            +{row.deltaPct}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--accent-green)]">
                            {isZero ? "—" : formatCost(row.deltaCost)}
                          </td>
                          {/* Δ Tokens */}
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)] border-l border-[var(--border-subtle)]">
                            {isZero ? "—" : formatTokens(row.deltaTotal)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)] whitespace-nowrap">
                            {isZero ? "—" : fmtTC(row.deltaInput, row.deltaInputCost)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)] whitespace-nowrap">
                            {isZero ? "—" : fmtTC(row.deltaOutput, row.deltaOutputCost)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)] whitespace-nowrap">
                            {isZero ? "—" : fmtTC(row.deltaCacheW, row.deltaCacheWCost)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)] whitespace-nowrap">
                            {isZero ? "—" : fmtTC(row.deltaCacheR, row.deltaCacheRCost)}
                          </td>
                          {/* Per 1% (base) */}
                          <td
                            className="py-1 px-1.5 text-right tabular-nums font-medium border-l border-[var(--border-subtle)]"
                            style={{
                              color: isZero
                                ? "var(--text-muted)"
                                : row.normalizedCostPerPct > week.avgCostPerPct * 1.5
                                ? "var(--accent-red)"
                                : row.normalizedCostPerPct < week.avgCostPerPct * 0.5
                                ? "var(--accent-orange)"
                                : "var(--text-primary)",
                            }}
                          >
                            {isZero ? "—" : formatCost(row.rawCostPerPct)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums font-medium text-[var(--accent-green)]">
                            {isZero ? "—" : formatCost(row.normalizedCostPerPct)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)] whitespace-nowrap">
                            {isZero ? "—" : fmtTC(row.deltaInput / row.deltaPct, row.deltaInputCost / row.deltaPct)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)] whitespace-nowrap">
                            {isZero ? "—" : fmtTC(row.outputPerPct, row.deltaOutputCost / row.deltaPct)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)] whitespace-nowrap">
                            {isZero ? "—" : fmtTC(row.deltaCacheW / row.deltaPct, row.deltaCacheWCost / row.deltaPct)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)] whitespace-nowrap">
                            {isZero ? "—" : fmtTC(row.deltaCacheR / row.deltaPct, row.deltaCacheRCost / row.deltaPct)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)]">
                            {isZero ? "—" : formatTokens(row.totalPerPct)}
                          </td>
                          {/* Est. 100% */}
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--accent-green)] border-l border-[var(--border-subtle)]">
                            {isZero ? "—" : formatCost(row.normalizedCostPerPct * 100)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--accent-blue)]">
                            {isZero ? "—" : formatTokens(row.outputPerPct * 100)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--accent-cyan)]">
                            {isZero ? "—" : formatTokens(row.totalPerPct * 100)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)] whitespace-nowrap">
                            {row.minutesBetween < 60
                              ? `${row.minutesBetween}m`
                              : `${Math.floor(row.minutesBetween / 60)}h${
                                  row.minutesBetween % 60
                                    ? ` ${row.minutesBetween % 60}m`
                                    : ""
                                }`}
                          </td>
                        </tr>
                        {isExpanded &&
                          row.modelDeltas.map((md) => (
                            <tr
                              key={`${rowKey}-${md.model}`}
                              className="border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]"
                            >
                              <td className="py-0.5 px-1.5 pl-6 text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                                └ {md.model}
                              </td>
                              <td />
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--accent-green)]">
                                {md.deltaCost > 0 ? formatCost(md.deltaCost) : "—"}
                              </td>
                              {/* Δ Tokens for model */}
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)] border-l border-[var(--border-subtle)]">
                                {md.deltaTotal > 0 ? formatTokens(md.deltaTotal) : "—"}
                              </td>
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                                {md.deltaInput > 0 ? fmtTC(md.deltaInput, md.deltaInputCost) : "—"}
                              </td>
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                                {md.deltaOutput > 0 ? fmtTC(md.deltaOutput, md.deltaOutputCost) : "—"}
                              </td>
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                                {md.deltaCacheW > 0 ? fmtTC(md.deltaCacheW, md.deltaCacheWCost) : "—"}
                              </td>
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                                {md.deltaCacheR > 0 ? fmtTC(md.deltaCacheR, md.deltaCacheRCost) : "—"}
                              </td>
                              {/* Per 1% for model */}
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)] border-l border-[var(--border-subtle)]">
                                {md.deltaCost > 0 && row.deltaPct > 0
                                  ? formatCost(md.deltaCost / row.deltaPct)
                                  : "—"}
                              </td>
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)]">
                                —
                              </td>
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                                {md.deltaInput > 0 && row.deltaPct > 0
                                  ? fmtTC(md.deltaInput / row.deltaPct, md.deltaInputCost / row.deltaPct)
                                  : "—"}
                              </td>
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                                {md.deltaOutput > 0 && row.deltaPct > 0
                                  ? fmtTC(md.deltaOutput / row.deltaPct, md.deltaOutputCost / row.deltaPct)
                                  : "—"}
                              </td>
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                                {md.deltaCacheW > 0 && row.deltaPct > 0
                                  ? fmtTC(md.deltaCacheW / row.deltaPct, md.deltaCacheWCost / row.deltaPct)
                                  : "—"}
                              </td>
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                                {md.deltaCacheR > 0 && row.deltaPct > 0
                                  ? fmtTC(md.deltaCacheR / row.deltaPct, md.deltaCacheRCost / row.deltaPct)
                                  : "—"}
                              </td>
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)]">
                                {md.deltaTotal > 0 ? formatTokens(md.deltaTotal / row.deltaPct) : "—"}
                              </td>
                              <td colSpan={4} />
                            </tr>
                          ))}
                      </Fragment>
                    );
                  })}
                  {/* ── Σ Summary row ── */}
                  {(week.rows.length > 1 || summaryOnly) && (
                    <tr className="border-t-2 border-[var(--border-subtle)] bg-[var(--bg-secondary)] font-semibold">
                      <td className="py-1.5 px-1.5 text-[var(--accent-purple)] whitespace-nowrap text-[11px]">
                        Σ {week.weekLabel}
                      </td>
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--accent-purple)]">
                        {week.totals.totalDeltaPct}
                      </td>
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--accent-green)]">
                        {week.totals.totalDeltaCost > 0 ? formatCost(week.totals.totalDeltaCost) : "—"}
                      </td>
                      {/* Δ Tokens totals */}
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--text-secondary)] border-l border-[var(--border-subtle)]">
                        {week.totals.totalDeltaTotal > 0 ? formatTokens(week.totals.totalDeltaTotal) : "—"}
                      </td>
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--text-muted)] whitespace-nowrap">
                        {week.totals.totalDeltaInput > 0 ? fmtTC(week.totals.totalDeltaInput, week.totals.totalDeltaInputCost) : "—"}
                      </td>
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--text-muted)] whitespace-nowrap">
                        {week.totals.totalDeltaOutput > 0 ? fmtTC(week.totals.totalDeltaOutput, week.totals.totalDeltaOutputCost) : "—"}
                      </td>
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--text-muted)] whitespace-nowrap">
                        {week.totals.totalDeltaCacheW > 0 ? fmtTC(week.totals.totalDeltaCacheW, week.totals.totalDeltaCacheWCost) : "—"}
                      </td>
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--text-muted)] whitespace-nowrap">
                        {week.totals.totalDeltaCacheR > 0 ? fmtTC(week.totals.totalDeltaCacheR, week.totals.totalDeltaCacheRCost) : "—"}
                      </td>
                      {/* Per 1% averages */}
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--text-primary)] border-l border-[var(--border-subtle)]">
                        {week.totals.avgRawCostPerPct > 0 ? formatCost(week.totals.avgRawCostPerPct) : "—"}
                      </td>
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--accent-green)]">
                        {week.totals.avgCostPerPct > 0 ? formatCost(week.totals.avgCostPerPct) : "—"}
                      </td>
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--text-secondary)] whitespace-nowrap">
                        {week.totals.avgInputPerPct > 0 ? fmtTC(week.totals.avgInputPerPct, week.totals.totalDeltaInputCost / week.totals.totalDeltaPct) : "—"}
                      </td>
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--text-secondary)] whitespace-nowrap">
                        {week.totals.avgOutputPerPct > 0 ? fmtTC(week.totals.avgOutputPerPct, week.totals.totalDeltaOutputCost / week.totals.totalDeltaPct) : "—"}
                      </td>
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--text-secondary)] whitespace-nowrap">
                        {week.totals.avgCacheWPerPct > 0 ? fmtTC(week.totals.avgCacheWPerPct, week.totals.totalDeltaCacheWCost / week.totals.totalDeltaPct) : "—"}
                      </td>
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--text-secondary)] whitespace-nowrap">
                        {week.totals.avgCacheRPerPct > 0 ? fmtTC(week.totals.avgCacheRPerPct, week.totals.totalDeltaCacheRCost / week.totals.totalDeltaPct) : "—"}
                      </td>
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--text-secondary)]">
                        {week.totals.avgTotalPerPct > 0 ? formatTokens(week.totals.avgTotalPerPct) : "—"}
                      </td>
                      {/* Est 100% */}
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--accent-green)] border-l border-[var(--border-subtle)]">
                        {week.totals.estCost100 > 0 ? formatCost(week.totals.estCost100) : "—"}
                      </td>
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--accent-blue)]">
                        {week.totals.estOutput100 > 0 ? formatTokens(week.totals.estOutput100) : "—"}
                      </td>
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--accent-cyan)]">
                        {week.totals.estTotal100 > 0 ? formatTokens(week.totals.estTotal100) : "—"}
                      </td>
                      <td className="py-1.5 px-1.5 text-right tabular-nums text-[var(--text-muted)] whitespace-nowrap">
                        {week.totals.totalMinutes < 60
                          ? `${week.totals.totalMinutes}m`
                          : `${Math.floor(week.totals.totalMinutes / 60)}h${
                              week.totals.totalMinutes % 60
                                ? ` ${week.totals.totalMinutes % 60}m`
                                : ""
                            }`}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
      </div>
    </div>
  );
}
