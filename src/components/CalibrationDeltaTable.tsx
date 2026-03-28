"use client";

import { Fragment, useMemo, useState } from "react";
import { CalibrationPoint, CalibrationScope, ModelTokenBreakdown } from "@/lib/types";
import { formatTokens, formatCost, formatDateTime } from "@/lib/format";

interface Props {
  calibrations: CalibrationPoint[];
}

type ScopeFilter = "weekly-all" | "weekly-sonnet" | "5h";

interface DeltaRow {
  fromPct: number;
  toPct: number;
  deltaPct: number;
  fromTime: string;
  toTime: string;
  deltaCost: number;
  costPerPct: number;
  deltaOutput: number;
  outputPerPct: number;
  deltaInput: number;
  inputPerPct: number;
  deltaTotal: number;
  totalPerPct: number;
  deltaCacheW: number;
  deltaCacheR: number;
  minutesBetween: number;
  modelDeltas: { model: string; deltaCost: number; deltaInput: number; deltaOutput: number; deltaCacheW: number; deltaCacheR: number; deltaTotal: number }[];
}

interface WeekGroup {
  weekLabel: string;
  weekStart: string;
  pointCount: number;
  rows: DeltaRow[];
  totalDeltaPct: number;
  avgCostPerPct: number;
  avgOutputPerPct: number;
  avgTotalPerPct: number;
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

const SCOPE_TABS: { key: ScopeFilter; label: string }[] = [
  { key: "weekly-all", label: "Weekly ALL" },
  { key: "weekly-sonnet", label: "Weekly Sonnet" },
  { key: "5h", label: "5h Windows" },
];

export function CalibrationDeltaTable({ calibrations }: Props) {
  const [scope, setScope] = useState<ScopeFilter>("weekly-all");
  const [minDelta, setMinDelta] = useState(0);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

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
          p.reportedPct > 0 &&
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
        const modelDeltas: DeltaRow["modelDeltas"] = [];
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
            if (dCost !== 0 || dOut !== 0 || dTot !== 0) {
              modelDeltas.push({ model, deltaCost: dCost, deltaInput: dIn, deltaOutput: dOut, deltaCacheW: dCW, deltaCacheR: dCR, deltaTotal: dTot });
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
          costPerPct: deltaCost / deltaPct,
          deltaOutput,
          outputPerPct: deltaOutput / deltaPct,
          deltaInput,
          inputPerPct: deltaInput / deltaPct,
          deltaTotal,
          totalPerPct: deltaTotal / deltaPct,
          deltaCacheW,
          deltaCacheR,
          minutesBetween,
          modelDeltas,
        });
      }

      if (rows.length === 0) continue;

      const validRows = rows.filter((r) => r.deltaCost > 0);
      const totalDelta = rows.reduce((s, r) => s + r.deltaPct, 0);
      const weightedCost = validRows.reduce(
        (s, r) => s + r.costPerPct * r.deltaPct,
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

      result.push({
        weekLabel: getGroupLabel(weekStart, scope),
        weekStart,
        pointCount: pts.length,
        rows,
        totalDeltaPct: totalDelta,
        avgCostPerPct: validDelta > 0 ? weightedCost / validDelta : 0,
        avgOutputPerPct: validDelta > 0 ? weightedOut / validDelta : 0,
        avgTotalPerPct: validDelta > 0 ? weightedTot / validDelta : 0,
      });
    }

    return result.sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  }, [calibrations, scope, minDelta]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Calibration Δ Analysis
          </h3>
          <p className="text-[10px] text-[var(--text-muted)]">
            Porównanie między kolejnymi kalibracjami — ile tokenów/kosztu na 1% różnicy.
          </p>
        </div>

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

      {weekGroups.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          Brak danych — potrzeba min. 2 kalibracje w jednym tygodniu.
        </p>
      ) : (
        weekGroups.map((week) => (
          <div key={week.weekStart} className="space-y-1">
            <div className="flex items-center gap-3 py-1">
              <span className="text-xs font-semibold text-[var(--text-primary)]">
                {week.weekLabel}
              </span>
              <span className="text-[10px] text-[var(--text-muted)]">
                {week.pointCount} cal · Δ{week.totalDeltaPct}% covered
              </span>
              {week.avgCostPerPct > 0 && (
                <>
                  <span className="text-[10px] text-[var(--accent-green)] font-medium">
                    avg {formatCost(week.avgCostPerPct)}/1%
                  </span>
                  <span className="text-[10px] text-[var(--text-muted)]">
                    →
                  </span>
                  <span className="text-[10px] text-[var(--accent-green)] font-medium">
                    est. {formatCost(week.avgCostPerPct * 100)} @100%
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
                  <col />
                  <col />
                  <col />
                  <col className="border-l border-[var(--border-subtle)]" />
                  <col />
                  <col />
                  <col />
                  <col />
                  <col className="border-l border-[var(--border-subtle)]" />
                  <col />
                  <col />
                  <col className="border-l border-[var(--border-subtle)]" />
                  <col />
                  <col />
                  <col />
                </colgroup>
                <thead>
                  <tr className="text-[9px] uppercase tracking-wider">
                    <th colSpan={3} className="text-left py-0.5 px-1.5 text-[var(--text-muted)] font-normal">
                      Delta
                    </th>
                    <th colSpan={5} className="text-left py-0.5 px-1.5 text-[var(--text-muted)] font-normal border-l border-[var(--border-subtle)]">
                      Δ Tokens
                    </th>
                    <th colSpan={3} className="text-left py-0.5 px-1.5 text-[var(--text-muted)] font-normal border-l border-[var(--border-subtle)]">
                      Per 1% (base)
                    </th>
                    <th colSpan={3} className="text-left py-0.5 px-1.5 text-[var(--text-muted)] font-normal border-l border-[var(--border-subtle)]">
                      Est. 100% limit (no promo)
                    </th>
                    <th />
                  </tr>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="text-left py-1 px-1.5 text-[var(--text-muted)] font-medium">Range</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Δ%</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Δ Cost</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium border-l border-[var(--border-subtle)]">All</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">In</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Out</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">CacheW</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">CacheR</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium border-l border-[var(--border-subtle)]">$/1%</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Out/1%</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Tot/1%</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium border-l border-[var(--border-subtle)]">Cost</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Output</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Total</th>
                    <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {week.rows.map((row, idx) => {
                    const isZero = row.deltaCost <= 0;
                    const rowKey = `${week.weekStart}-${idx}`;
                    const hasModels = row.modelDeltas.length > 0;
                    const isExpanded = expandedRows.has(rowKey);
                    return (
                      <Fragment key={idx}>
                        <tr
                          className={`border-b border-[var(--border-subtle)] ${
                            isZero ? "opacity-30" : ""
                          } ${hasModels && !isZero ? "cursor-pointer hover:bg-[var(--bg-secondary)]" : ""}`}
                          onClick={hasModels && !isZero ? () => toggleRow(rowKey) : undefined}
                        >
                          {/* Zone 1: Delta */}
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
                          {/* Zone: Δ Tokens */}
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)] border-l border-[var(--border-subtle)]">
                            {isZero ? "—" : formatTokens(row.deltaTotal)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                            {isZero ? "—" : formatTokens(row.deltaInput)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                            {isZero ? "—" : formatTokens(row.deltaOutput)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                            {isZero ? "—" : formatTokens(row.deltaCacheW)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                            {isZero ? "—" : formatTokens(row.deltaCacheR)}
                          </td>
                          {/* Zone: Per 1% (base, normalized) */}
                          <td
                            className="py-1 px-1.5 text-right tabular-nums font-medium border-l border-[var(--border-subtle)]"
                            style={{
                              color: isZero
                                ? "var(--text-muted)"
                                : row.costPerPct > week.avgCostPerPct * 1.5
                                ? "var(--accent-red)"
                                : row.costPerPct < week.avgCostPerPct * 0.5
                                ? "var(--accent-orange)"
                                : "var(--text-primary)",
                            }}
                          >
                            {isZero ? "—" : formatCost(row.costPerPct)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)]">
                            {isZero ? "—" : formatTokens(row.outputPerPct)}
                          </td>
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)]">
                            {isZero ? "—" : formatTokens(row.totalPerPct)}
                          </td>
                          {/* Zone 3: Estimated 100% (no promo) */}
                          <td className="py-1 px-1.5 text-right tabular-nums text-[var(--accent-green)] border-l border-[var(--border-subtle)]">
                            {isZero ? "—" : formatCost(row.costPerPct * 100)}
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
                              key={`${idx}-${md.model}`}
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
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)]">
                                {md.deltaInput > 0 ? formatTokens(md.deltaInput) : "—"}
                              </td>
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)]">
                                {md.deltaOutput > 0 ? formatTokens(md.deltaOutput) : "—"}
                              </td>
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)]">
                                {md.deltaCacheW > 0 ? formatTokens(md.deltaCacheW) : "—"}
                              </td>
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)]">
                                {md.deltaCacheR > 0 ? formatTokens(md.deltaCacheR) : "—"}
                              </td>
                              {/* Per 1% for model */}
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)] border-l border-[var(--border-subtle)]">
                                {md.deltaCost > 0 && row.deltaPct > 0
                                  ? formatCost(md.deltaCost / row.deltaPct)
                                  : "—"}
                              </td>
                              <td className="py-0.5 px-1.5 text-right tabular-nums text-[10px] text-[var(--text-muted)]">
                                {md.deltaOutput > 0 ? formatTokens(md.deltaOutput / row.deltaPct) : "—"}
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
