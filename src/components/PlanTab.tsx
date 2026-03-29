"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  PlanPeriod,
  PlanTier,
  PLAN_TIERS,
  CalibrationScope,
  CalibrationPoint,
  SolvedLimits,
  WeeklyBucket,
  LimitsData,
  PromoPeriod,
  getDefaultLimits,
} from "@/lib/types";
import { formatTokens, formatCost, formatDate } from "@/lib/format";
import { estimateUtilization, findCalibrationAnchor } from "@/lib/calibration";
import { isInPromoRange, isInPromoSchedule } from "@/lib/utilization";
import { getPlanForDate, getPlanTierForDate, weekKeyFromDate } from "@/lib/plans";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toDateInput(iso: string): string {
  return iso.slice(0, 10);
}

function fromDateInput(val: string): string {
  return new Date(val + "T00:00:00").toISOString();
}

// ─── Add/Edit Plan Dialog ────────────────────────────────────────────────────

interface PlanDialogProps {
  initial?: PlanPeriod;
  onSave: (period: Omit<PlanPeriod, "id"> & { id?: string }) => void;
  onClose: () => void;
}

function PlanDialog({ initial, onSave, onClose }: PlanDialogProps) {
  const [mounted, setMounted] = useState(false);
  const [tier, setTier] = useState<PlanTier>(initial?.tier ?? "max20");
  const [startDate, setStartDate] = useState(initial ? toDateInput(initial.startDate) : "");
  const [endDate, setEndDate] = useState(initial?.endDate ? toDateInput(initial.endDate) : "");
  const [note, setNote] = useState(initial?.note ?? "");

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const handleSave = () => {
    if (!startDate) return;
    onSave({
      id: initial?.id,
      tier,
      startDate: fromDateInput(startDate),
      endDate: endDate ? fromDateInput(endDate) : null,
      note: note || undefined,
    });
    onClose();
  };

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50">
      <div className="card p-5 w-full max-w-sm mx-4">
        <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">
          {initial ? "Edit Plan Period" : "Add Plan Period"}
        </h3>

        <div className="space-y-3 mb-5">
          {/* Tier selector */}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1.5">Plan</label>
            <div className="grid grid-cols-5 gap-1">
              {(Object.keys(PLAN_TIERS) as PlanTier[]).map((t) => {
                const info = PLAN_TIERS[t];
                const selected = tier === t;
                return (
                  <button
                    key={t}
                    onClick={() => setTier(t)}
                    className={`px-2 py-2 rounded-lg text-[11px] font-medium transition-all border ${
                      selected
                        ? "border-current shadow-sm"
                        : "border-[var(--border-subtle)] hover:border-current"
                    }`}
                    style={{
                      color: info.color,
                      background: selected ? `color-mix(in srgb, ${info.color} 15%, transparent)` : undefined,
                    }}
                  >
                    <div>{info.shortLabel}</div>
                    <div className="text-[9px] opacity-70">${info.monthlyPrice}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">Start</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                style={{ colorScheme: "dark" }}
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">End <span className="opacity-50">(empty = current)</span></label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                style={{ colorScheme: "dark" }}
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
              />
            </div>
          </div>

          {/* Note */}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Note <span className="opacity-50">(optional)</span></label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. trial period, upgraded"
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
            />
          </div>
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!startDate}
            className="px-4 py-2 text-xs font-medium bg-[var(--accent-blue)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Plan Timeline (Periods tab) ─────────────────────────────────────────────

interface PlanTimelineProps {
  periods: PlanPeriod[];
  onEdit: (p: PlanPeriod) => void;
  onDelete: (id: string) => void;
}

function PlanTimeline({ periods, onEdit, onDelete }: PlanTimelineProps) {
  const currentPlan = getPlanForDate(new Date().toISOString(), periods);
  const currentTierInfo = currentPlan ? PLAN_TIERS[currentPlan.tier] : null;

  const sorted = [...periods].sort(
    (a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
  );

  return (
    <div className="space-y-4">
      {/* Current plan highlight */}
      {currentPlan && currentTierInfo ? (
        <div
          className="flex items-center gap-4 p-4 rounded-xl"
          style={{ background: `color-mix(in srgb, ${currentTierInfo.color} 10%, transparent)` }}
        >
          <div
            className="w-14 h-14 rounded-xl flex items-center justify-center text-base font-bold shrink-0"
            style={{
              background: `color-mix(in srgb, ${currentTierInfo.color} 25%, transparent)`,
              color: currentTierInfo.color,
            }}
          >
            {currentTierInfo.shortLabel}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold" style={{ color: currentTierInfo.color }}>
                {currentTierInfo.label}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-green)]/20 text-[var(--accent-green)] font-medium">
                current
              </span>
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-0.5">
              ${currentTierInfo.monthlyPrice}/mo · od {formatDate(currentPlan.startDate)}
              {currentPlan.note && <span className="ml-2 opacity-70">· {currentPlan.note}</span>}
            </div>
            <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
              {currentTierInfo.multiplier === 1
                ? "Reference tier (100% Max $200)"
                : `${(currentTierInfo.multiplier * 100).toFixed(0)}% limitów Max $200`}
            </div>
          </div>
        </div>
      ) : (
        <div className="p-4 rounded-xl border border-dashed border-[var(--border-subtle)] text-center text-sm text-[var(--text-muted)]">
          Brak aktywnego planu — dodaj pierwszy okres.
        </div>
      )}

      {/* Period list */}
      {sorted.length === 0 ? (
        <div className="text-center py-6 text-[var(--text-muted)] text-sm">
          Brak skonfigurowanych okresów.
        </div>
      ) : (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2 px-1">
            Historia planów
          </div>
          <div className="space-y-1.5">
            {sorted.map((p) => {
              const info = PLAN_TIERS[p.tier];
              const isCurrent = !p.endDate;
              return (
                <div
                  key={p.id}
                  className="flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors"
                  style={{
                    borderColor: isCurrent
                      ? `color-mix(in srgb, ${info.color} 50%, transparent)`
                      : `color-mix(in srgb, ${info.color} 25%, transparent)`,
                    background: isCurrent
                      ? `color-mix(in srgb, ${info.color} 6%, transparent)`
                      : undefined,
                  }}
                >
                  {/* Badge */}
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center text-[11px] font-bold shrink-0"
                    style={{
                      background: `color-mix(in srgb, ${info.color} 20%, transparent)`,
                      color: info.color,
                    }}
                  >
                    {info.shortLabel}
                  </div>

                  {/* Plan name + dates */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium" style={{ color: info.color }}>
                        {info.label}
                      </span>
                      {isCurrent && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--accent-green)]/20 text-[var(--accent-green)]">
                          current
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-[var(--text-muted)] mt-0.5 tabular-nums">
                      {formatDate(p.startDate)}
                      {" — "}
                      {p.endDate ? formatDate(p.endDate) : <span className="text-[var(--accent-green)]">ongoing</span>}
                      {p.note && <span className="ml-2 opacity-60">· {p.note}</span>}
                    </div>
                  </div>

                  {/* Price */}
                  <div className="text-xs text-[var(--text-muted)] tabular-nums shrink-0 w-12 text-right">
                    ${info.monthlyPrice}/mo
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => onEdit(p)}
                      className="px-2 py-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-blue)] hover:bg-[var(--bg-secondary)] transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => onDelete(p.id)}
                      className="px-2 py-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-red)] hover:bg-[var(--bg-secondary)] transition-colors"
                    >
                      Del
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Weekly Chart with Max 20 reference ──────────────────────────────────────

interface WeeklyPlanChartProps {
  weeklyAll: WeeklyBucket[];
  periods: PlanPeriod[];
  solvedLimits: Record<CalibrationScope, SolvedLimits>;
  promoPeriods?: PromoPeriod[];
  calibrations?: CalibrationPoint[];
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate().toString().padStart(2, "0")}.${(d.getUTCMonth() + 1).toString().padStart(2, "0")}`;
}

function weekEndDate(weekStart: string): string {
  const d = new Date(weekStart);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString();
}

function WeeklyPlanChart({ weeklyAll, periods, solvedLimits, promoPeriods = [], calibrations = [] }: WeeklyPlanChartProps) {
  const sorted = [...weeklyAll].sort(
    (a, b) => new Date(a.weekStart).getTime() - new Date(b.weekStart).getTime()
  );

  if (sorted.length === 0) {
    return (
      <div className="text-center py-6 text-[var(--text-muted)] text-sm">
        No weekly data available.
      </div>
    );
  }

  const weekData = sorted.map((bucket) => {
    const weekKey = weekKeyFromDate(bucket.weekStart);
    const planPeriod = getPlanForDate(bucket.weekStart, periods);
    const tier = planPeriod?.tier ?? null;
    const tierInfo = tier ? PLAN_TIERS[tier] : null;

    let estimatedPct: number | null = null;
    const solved = solvedLimits["weekly-all"];
    const weekPlanMult = (tierInfo?.multiplier ?? 20) / 20;
    const weekAnchor = findCalibrationAnchor(calibrations, "weekly-all", bucket.weekStart);
    if (solved && solved.best.confidence > 0) {
      const est = estimateUtilization(
        {
          output: bucket.outputTokens,
          input: bucket.inputTokens,
          cacheWrite: bucket.cacheCreationTokens,
          cacheRead: bucket.cacheReadTokens,
          total: bucket.totalTokens,
        },
        bucket.totalCost,
        solved,
        (promoPeriods.length > 0 ? isInPromoSchedule(bucket.weekStart, promoPeriods) : isInPromoRange(bucket.weekStart)) ? "off-peak" : "peak",
        bucket.weekStart,
        undefined,
        promoPeriods,
        weekPlanMult,
        weekAnchor
      );
      if (est) estimatedPct = est.estimatedPct;
    }

    const multiplier = tierInfo?.multiplier ?? 1;
    const pctOfMax20 = estimatedPct !== null ? estimatedPct * multiplier : null;

    return { weekKey, bucket, tier, tierInfo, multiplier, estimatedPct, pctOfMax20, color: tierInfo?.color ?? "var(--text-muted)" };
  });

  const maxPct = Math.max(...weekData.map((w) => w.pctOfMax20 ?? 0), 100);
  const chartMax = Math.ceil(maxPct / 10) * 10;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">
          Weekly usage vs Max $200 reference
        </span>
        <span className="text-[10px] text-[var(--text-muted)]">
          100% = Max $200 weekly limit
        </span>
      </div>

      <div className="relative">
        <div
          className="absolute left-0 right-0 border-t border-dashed border-[var(--accent-purple)]/40"
          style={{ bottom: `${(100 / chartMax) * 100}%` }}
        >
          <span className="absolute -top-3 right-0 text-[9px] text-[var(--accent-purple)] opacity-60">
            100% Max $200
          </span>
        </div>

        <div className="flex items-end gap-1.5" style={{ height: 200 }}>
          {weekData.map((w) => {
            const barHeight = w.pctOfMax20 !== null ? (w.pctOfMax20 / chartMax) * 100 : 0;
            const isCurrent = w.bucket.timeRemainingMs > 0;
            return (
              <div key={w.weekKey} className="flex-1 flex flex-col items-center justify-end h-full min-w-0">
                {w.pctOfMax20 !== null && (
                  <span className="text-[9px] font-medium tabular-nums mb-0.5 whitespace-nowrap" style={{ color: w.color }}>
                    {w.pctOfMax20.toFixed(0)}%
                  </span>
                )}
                <div
                  className="w-full rounded-t transition-all duration-300 relative group"
                  style={{ height: `${Math.max(barHeight, 2)}%`, background: w.color, opacity: isCurrent ? 0.9 : 0.65 }}
                >
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10">
                    <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 shadow-lg whitespace-nowrap text-[10px]">
                      <div className="font-medium" style={{ color: w.color }}>
                        {w.tierInfo?.label ?? "Unknown"} — {fmtDay(w.bucket.weekStart)}–{fmtDay(weekEndDate(w.bucket.weekStart))}
                      </div>
                      <div className="text-[var(--text-muted)] mt-1">
                        <div className="opacity-60">{w.weekKey}</div>
                        {w.estimatedPct !== null && <div>Plan usage: {w.estimatedPct.toFixed(0)}% of {w.tierInfo?.label ?? "?"}</div>}
                        <div>vs Max $200: {w.pctOfMax20?.toFixed(1) ?? "—"}%</div>
                        <div>{formatTokens(w.bucket.totalTokens)} tokens · {formatCost(w.bucket.totalCost)}</div>
                      </div>
                    </div>
                  </div>
                </div>
                <span className="text-[8px] text-[var(--text-muted)] mt-1 truncate w-full text-center tabular-nums">
                  {fmtDay(w.bucket.weekStart)}
                </span>
                {w.tierInfo && (
                  <span className="text-[7px] font-bold truncate" style={{ color: w.color }}>
                    {w.tierInfo.shortLabel}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="absolute left-0 top-0 bottom-0 flex flex-col justify-between pointer-events-none" style={{ width: 0 }}>
          {[...Array(5)].map((_, i) => {
            const val = chartMax - (chartMax / 4) * i;
            return (
              <span key={i} className="text-[8px] text-[var(--text-muted)] -ml-8 tabular-nums">
                {val.toFixed(0)}%
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Main PlanTab Component ──────────────────────────────────────────────────

type PlanSubTab = "periods" | "weekly" | "limits";

const SUB_TABS: { key: PlanSubTab; label: string }[] = [
  { key: "periods", label: "Periods" },
  { key: "weekly", label: "Weekly" },
  { key: "limits", label: "Limits" },
];

// ─── Plan Limits Reference Table ────────────────────────────────────────────

const PLAN_TIER_KEYS: PlanTier[] = ["max20", "max5", "team", "pro"];

function PlanLimitsTable({ solvedLimits }: { solvedLimits: Record<CalibrationScope, SolvedLimits> }) {
  const scopes: { window: "5h" | "weekly"; label: string; scopeKey: CalibrationScope }[] = [
    { window: "5h", label: "5-Hour Window", scopeKey: "5h" },
    { window: "weekly", label: "7-Day (Weekly)", scopeKey: "weekly-all" },
  ];

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] text-[var(--text-muted)]">
          Limity per plan oparte na kalibracji (solved) lub domyślne (fallback). Skalowane przez mnożnik planu.
          Koszt (CV 0.20) to najstabilniejszy predyktor limitu.
        </p>
      </div>

      {scopes.map(({ window, label, scopeKey }) => {
        const solved = solvedLimits[scopeKey];
        const hasCalibrated = solved.methods.length > 0 && solved.best.confidence > 0;

        return (
          <div key={window}>
            <div className="flex items-center gap-2 mb-2">
              <h4 className="text-xs font-semibold text-[var(--text-secondary)]">
                {label}
              </h4>
              <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                hasCalibrated
                  ? "bg-[var(--accent-green)]/15 text-[var(--accent-green)]"
                  : "bg-[var(--bg-secondary)] text-[var(--text-muted)]"
              }`}>
                {hasCalibrated ? "calibrated" : "default"}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="text-left py-1.5 px-2 text-[var(--text-muted)] font-medium">Plan</th>
                    <th className="text-right py-1.5 px-2 text-[var(--text-muted)] font-medium">Mult</th>
                    <th className="text-right py-1.5 px-2 text-[var(--accent-orange)] font-medium">Cost Limit</th>
                    <th className="text-right py-1.5 px-2 text-[var(--text-muted)] font-medium">Output</th>
                    <th className="text-right py-1.5 px-2 text-[var(--text-muted)] font-medium">In+Out</th>
                    <th className="text-right py-1.5 px-2 text-[var(--text-muted)] font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {PLAN_TIER_KEYS.map((tier) => {
                    const info = PLAN_TIERS[tier];
                    let lim: { costLimit: number; outputLimit: number; inputOutputLimit: number; totalLimit: number };
                    if (hasCalibrated) {
                      const m = info.multiplier;
                      const base = 20; // Max $200 multiplier
                      lim = {
                        outputLimit: Math.round((solved.best.outputLimit / base) * m),
                        inputOutputLimit: Math.round((solved.best.inputOutputLimit / base) * m),
                        totalLimit: Math.round((solved.best.totalLimit / base) * m),
                        costLimit: Math.round(((solved.best.costLimit / base) * m) * 100) / 100,
                      };
                    } else {
                      lim = getDefaultLimits(tier, window);
                    }
                    return (
                      <tr key={tier} className="border-b border-[var(--border-subtle)]">
                        <td className="py-1.5 px-2 font-medium" style={{ color: info.color }}>
                          {info.label}
                          <span className="text-[var(--text-muted)] font-normal ml-1">
                            ${info.monthlyPrice}/mo
                          </span>
                        </td>
                        <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-muted)]">
                          {info.multiplier}x
                        </td>
                        <td className="py-1.5 px-2 text-right tabular-nums font-semibold text-[var(--accent-orange)]">
                          {formatCost(lim.costLimit)}
                        </td>
                        <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-secondary)]">
                          {formatTokens(lim.outputLimit)}
                        </td>
                        <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-secondary)]">
                          {formatTokens(lim.inputOutputLimit)}
                        </td>
                        <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-secondary)]">
                          {formatTokens(lim.totalLimit)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <p className="text-[9px] text-[var(--text-muted)]">
        Baza: solved limits z kalibracji (Max $200), skalowane mnożnikiem planu.
        Podczas promo 2x off-peak limity się podwajają.
      </p>
    </div>
  );
}

interface PlanTabProps {
  periods: PlanPeriod[];
  solvedLimits: Record<CalibrationScope, SolvedLimits>;
  limitsData: LimitsData;
  onPeriodsChange: () => void;
  promoPeriods?: PromoPeriod[];
  calibrations?: CalibrationPoint[];
}

export function PlanTab({
  periods,
  solvedLimits,
  limitsData,
  onPeriodsChange,
  promoPeriods = [],
  calibrations = [],
}: PlanTabProps) {
  const [subTab, setSubTab] = useState<PlanSubTab>("periods");
  const [showDialog, setShowDialog] = useState(false);
  const [editingPeriod, setEditingPeriod] = useState<PlanPeriod | null>(null);

  const handleSave = async (data: Omit<PlanPeriod, "id"> & { id?: string }) => {
    if (data.id) {
      await fetch("/api/plans", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    } else {
      await fetch("/api/plans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    }
    onPeriodsChange();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/plans?id=${id}`, { method: "DELETE" });
    onPeriodsChange();
  };

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Sub-tab nav */}
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-0">
        <div className="flex gap-1">
          {SUB_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setSubTab(t.key)}
              className={`px-4 py-2 text-xs font-medium transition-all border-b-2 -mb-px ${
                subTab === t.key
                  ? "border-[var(--accent-blue)] text-[var(--accent-blue)]"
                  : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {subTab === "periods" && (
          <button
            onClick={() => { setEditingPeriod(null); setShowDialog(true); }}
            className="mb-0.5 px-3 py-1.5 text-[11px] font-medium rounded-lg bg-[var(--accent-blue)] text-white hover:opacity-90 transition-opacity"
          >
            + Add Period
          </button>
        )}
      </div>

      {/* Tab content */}
      <div className="card p-5">
        {subTab === "periods" && (
          <PlanTimeline
            periods={periods}
            onEdit={(p) => { setEditingPeriod(p); setShowDialog(true); }}
            onDelete={handleDelete}
          />
        )}

        {subTab === "weekly" && (
          <WeeklyPlanChart
            weeklyAll={limitsData.weeklyAll}
            periods={periods}
            solvedLimits={solvedLimits}
            promoPeriods={promoPeriods}
            calibrations={calibrations}
          />
        )}

        {subTab === "limits" && (
          <PlanLimitsTable solvedLimits={solvedLimits} />
        )}

      </div>

      {/* Dialog */}
      {showDialog && (
        <PlanDialog
          initial={editingPeriod ?? undefined}
          onSave={handleSave}
          onClose={() => { setShowDialog(false); setEditingPeriod(null); }}
        />
      )}
    </div>
  );
}
