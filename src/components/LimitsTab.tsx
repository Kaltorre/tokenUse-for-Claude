"use client";

import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  LimitsData,
  FiveHourWindow,
  WeeklyBucket,
  CalibrationScope,
  SolvedLimits,
  DerivedLimits,
  SessionOverrides,
  CalibrationPoint,
  PlanPeriod,
  PLAN_TIERS,
  PromoPeriod,
} from "@/lib/types";
import { getPlanTierForDate, weekKeyFromDate } from "@/lib/plans";
import { formatTokens, formatCost } from "@/lib/format";
import { estimateUtilization, getCalibrationForWindow, findCalibrationAnchor } from "@/lib/calibration";
import {
  calcUtilization,
  getActivePromoMultiplier,
  isInPromoRange,
  BOTTLENECK_LABELS,
  BOTTLENECK_COLORS,
} from "@/lib/utilization";
import { computeWeightedPromoMultiplier } from "@/lib/limits-analyzer";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatLocalTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit" });
}

function formatLocalDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pl-PL", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
}

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "00:00";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function formatWeekRange(weekStart: string, weekEnd: string): string {
  const s = new Date(weekStart);
  const e = new Date(weekEnd);
  const fmt = (d: Date) => d.toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit" });
  return `${fmt(s)} – ${fmt(e)}`;
}

/** Standard ISO week key: YYYY-WNN */
function isoWeekKey(dateStr: string): string {
  const date = new Date(dateStr);
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo.toString().padStart(2, "0")}`;
}

/** Convert ISO timestamp to datetime-local input value (local time) */
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Convert datetime-local input value to ISO timestamp */
function fromDatetimeLocal(local: string): string {
  return new Date(local).toISOString();
}

function getStartPromoMultiplier(windowStart: string, promoPeriods: PromoPeriod[] = []): number {
  if (promoPeriods.length > 0) {
    return getActivePromoMultiplier(windowStart, promoPeriods);
  }
  return isInPromoRange(windowStart) ? 2 : 1;
}

function getWindowPromoMultiplier(
  win: Pick<FiveHourWindow, "startTime" | "peakStatus" | "peakSplit">,
  promoPeriods: PromoPeriod[] = []
): number {
  if (win.peakStatus === "mixed" && win.peakSplit) {
    return computeWeightedPromoMultiplier(win.peakSplit);
  }
  if (win.peakStatus === "off-peak") {
    const configured = getStartPromoMultiplier(win.startTime, promoPeriods);
    return configured > 1 ? configured : 1;
  }
  return 1;
}

function getWeeklyPromoMultiplier(
  bucket: Pick<WeeklyBucket, "weekStart" | "peakStatus" | "peakSplit">,
  promoPeriods: PromoPeriod[] = []
): number {
  if (bucket.peakStatus === "mixed" && bucket.peakSplit) {
    return computeWeightedPromoMultiplier(bucket.peakSplit);
  }
  if (bucket.peakStatus === "off-peak") {
    const configured = getStartPromoMultiplier(bucket.weekStart, promoPeriods);
    return configured > 1 ? configured : 1;
  }
  return 1;
}

type WeeklyOverrideScope = "all" | "sonnet";

function getWeeklyOverrideStorageKey(
  scope: WeeklyOverrideScope,
  bucket: Pick<WeeklyBucket, "weekStart">
): string {
  return `${scope}:${bucket.weekStart}`;
}

function getWeeklyOverrideMatch(
  overrides: SessionOverrides,
  bucket: Pick<WeeklyBucket, "weekStart">,
  scope: WeeklyOverrideScope
): { key: string; entry: SessionOverrides["weekly"][string] } | null {
  const scopedKey = getWeeklyOverrideStorageKey(scope, bucket);
  if (overrides.weekly[scopedKey]) {
    return { key: scopedKey, entry: overrides.weekly[scopedKey] };
  }

  const legacyKey = weekKeyFromDate(bucket.weekStart);
  if (overrides.weekly[legacyKey]) {
    return { key: legacyKey, entry: overrides.weekly[legacyKey] };
  }

  return null;
}

// ─── Token breakdown sub-component ───────────────────────────────────────────

interface TokenBreakdownProps {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost?: number;
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  derivedLimits: DerivedLimits | null;
  scope: CalibrationScope;
  peakStatus?: "peak" | "off-peak" | "mixed";
  peakSplit?: FiveHourWindow["peakSplit"];
  windowStart?: string;
  promoPeriods?: PromoPeriod[];
  planMultiplier?: number;
}

function TokenBreakdown({
  inputTokens,
  outputTokens,
  cacheCreationTokens,
  cacheReadTokens,
  totalTokens,
  totalCost,
  solvedLimits,
  derivedLimits,
  scope,
  peakStatus = "off-peak",
  peakSplit,
  windowStart = new Date().toISOString(),
  planMultiplier = 1,
  promoPeriods = [],
}: TokenBreakdownProps) {
  // Try to compute per-type % of limit
  let outputPct: number | null = null;
  let ioPct: number | null = null;
  let totalPct: number | null = null;
  let bottleneck: string | null = null;

  if (solvedLimits) {
    const solved = solvedLimits[scope];
    if (solved && solved.best.confidence > 0) {
      const est = estimateUtilization(
        { output: outputTokens, input: inputTokens, cacheWrite: cacheCreationTokens, cacheRead: cacheReadTokens, total: totalTokens },
        totalTokens * 0.001, // cost placeholder
        solved,
        peakStatus,
        windowStart,
        peakSplit,
        promoPeriods,
        planMultiplier
      );
      if (est) {
        outputPct = est.outputPct;
        ioPct = est.ioPct;
        totalPct = est.totalPct;
        bottleneck = est.bottleneck;
      }
    }
  }

  if (outputPct === null && derivedLimits) {
    const util = calcUtilization(
      { outputTokens, inputTokens, totalTokens },
      derivedLimits,
      peakStatus,
      windowStart,
      scope === "5h" ? "5h" : "weekly",
      peakSplit,
      promoPeriods,
      planMultiplier
    );
    if (util) {
      outputPct = util.outputPct;
      ioPct = util.inoutPct;
      totalPct = util.totalPct;
      bottleneck = util.bottleneck;
    }
  }

  const rows: { label: string; value: number; color: string; pct?: number | null; isBn: boolean }[] = [
    { label: "Input", value: inputTokens, color: "var(--accent-blue)", isBn: false },
    { label: "Output", value: outputTokens, color: "var(--accent-green)", pct: outputPct, isBn: bottleneck === "output" },
    { label: "Cache Write", value: cacheCreationTokens, color: "var(--accent-purple)", isBn: false },
    { label: "Cache Read", value: cacheReadTokens, color: "var(--accent-cyan)", isBn: false },
  ];

  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const barWidth = totalTokens > 0 ? (r.value / totalTokens) * 100 : 0;
        return (
          <div key={r.label} className="flex items-center gap-2 text-xs">
            <span className="w-20 text-[var(--text-muted)] text-right shrink-0">{r.label}</span>
            <div className="flex-1 h-2.5 bg-[var(--bg-primary)] rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${Math.min(barWidth, 100)}%`, background: r.color }} />
            </div>
            <span className="w-16 text-[var(--text-secondary)] tabular-nums text-right">{formatTokens(r.value)}</span>
          </div>
        );
      })}

      {/* Utilization summary row */}
      {outputPct !== null && (
        <div className="flex items-center gap-3 pt-1.5 border-t border-[var(--border-subtle)] text-[10px]">
          {([
            ["Out", outputPct, "output"],
            ["I/O", ioPct, "inout"],
            ["Total", totalPct, "total"],
          ] as [string, number | null, string][]).map(([label, val, key]) => {
            const isBn = bottleneck === key;
            const color = isBn
              ? BOTTLENECK_COLORS[key as keyof typeof BOTTLENECK_COLORS] ?? "var(--text-secondary)"
              : "var(--text-muted)";
            return (
              <span key={key} style={{ color }} className={isBn ? "font-semibold" : ""}>
                {label} {val !== null ? `${val.toFixed(1)}%` : "—"}
                {isBn && " *"}
              </span>
            );
          })}
          <span className="ml-auto text-[var(--text-muted)]">
            {BOTTLENECK_LABELS[bottleneck as keyof typeof BOTTLENECK_LABELS] ?? ""}
          </span>
        </div>
      )}

      {/* Total row */}
      <div className="flex justify-between pt-1 border-t border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]">
        <span className="font-medium text-[var(--text-secondary)] tabular-nums">
          {formatTokens(totalTokens)} total
        </span>
        {totalCost != null && (
          <span className="font-medium text-[var(--text-secondary)] tabular-nums">
            {formatCost(totalCost)}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Edit Boundaries Dialog ───────────────────────────────────────────────────

interface EditDialogProps {
  type: "weekly" | "5h";
  overrideKey: string;
  initialStart: string;
  initialEnd: string;
  onSave: (start: string, end: string) => Promise<void>;
  onClose: () => void;
}

function EditBoundariesDialog({
  type,
  overrideKey,
  initialStart,
  initialEnd,
  onSave,
  onClose,
}: EditDialogProps) {
  const [mounted, setMounted] = useState(false);
  const [start, setStart] = useState(toDatetimeLocal(initialStart));
  const [end, setEnd] = useState(toDatetimeLocal(initialEnd));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(fromDatetimeLocal(start), fromDatetimeLocal(end));
      onClose();
    } finally {
      setSaving(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50">
      <div className="card p-5 w-full max-w-sm mx-4">
        <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">
          Edit Window Boundaries
        </h3>
        <div className="text-[10px] text-[var(--text-muted)] mb-4">
          {type === "5h" ? "5h window" : "Weekly session"} — key: <code className="font-mono">{overrideKey}</code>
        </div>

        <div className="space-y-3 mb-5">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Start</label>
            <input
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">End</label>
            <input
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
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
            disabled={saving}
            className="px-4 py-2 text-xs font-medium bg-[var(--accent-blue)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Status Cards (Section A) ─────────────────────────────────────────────────

interface StatusCardsProps {
  currentWindow: FiveHourWindow | null;
  currentWeekAll: WeeklyBucket | null;
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  derivedLimits: DerivedLimits | null;
  promoPeriods?: PromoPeriod[];
}

function StatusCards({
  currentWindow,
  currentWeekAll,
  solvedLimits,
  derivedLimits,
  promoPeriods = [],
}: StatusCardsProps) {
  const [windowRemaining, setWindowRemaining] = useState(currentWindow?.timeRemainingMs ?? 0);
  const [weekRemaining, setWeekRemaining] = useState(currentWeekAll?.timeRemainingMs ?? 0);

  useEffect(() => {
    if (!currentWindow && !currentWeekAll) return;
    const tick = () => {
      if (currentWindow?.status === "active") {
        setWindowRemaining(Math.max(0, new Date(currentWindow.endTime).getTime() - Date.now()));
      }
      if (currentWeekAll && currentWeekAll.timeRemainingMs > 0) {
        setWeekRemaining(Math.max(0, new Date(currentWeekAll.weekEnd).getTime() - Date.now()));
      }
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [currentWindow, currentWeekAll]);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
      {/* Card 1: Active 5h Window */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-[var(--text-secondary)]">Active 5h Window</h3>
          {currentWindow ? (
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${currentWindow.status === "active" ? "bg-[var(--accent-green)] animate-pulse" : "bg-[var(--text-muted)]"}`} />
              <span className={`text-xs font-medium ${currentWindow.status === "active" ? "text-[var(--accent-green)]" : "text-[var(--text-muted)]"}`}>
                {currentWindow.status === "active" ? "ACTIVE" : "EXPIRED"}
              </span>
            </div>
          ) : null}
        </div>

        {!currentWindow ? (
          <p className="text-[var(--text-muted)] text-sm">No data — requires active usage window</p>
        ) : (
          <>
            <div className="flex items-center justify-between mb-3 text-xs">
              <span className="text-[var(--text-muted)]">
                {formatShortDate(currentWindow.startTime)} {formatLocalTime(currentWindow.startTime)} → {formatLocalTime(currentWindow.endTime)}
              </span>
              <span className="text-[var(--accent-orange)] font-mono font-medium">
                {windowRemaining > 0 ? `Resets in ${formatTimeRemaining(windowRemaining)}` : "Window expired"}
              </span>
            </div>
            <TokenBreakdown
              inputTokens={currentWindow.inputTokens}
              outputTokens={currentWindow.outputTokens}
              cacheCreationTokens={currentWindow.cacheCreationTokens}
              cacheReadTokens={currentWindow.cacheReadTokens}
              totalTokens={currentWindow.totalTokens}
              totalCost={currentWindow.totalCost}
              solvedLimits={solvedLimits}
              derivedLimits={derivedLimits}
              scope="5h"
              peakStatus={currentWindow.peakStatus}
              peakSplit={currentWindow.peakSplit}
              windowStart={currentWindow.startTime}
              promoPeriods={promoPeriods}
            />
          </>
        )}
      </div>

      {/* Card 2: Current Week */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-[var(--text-secondary)]">Current Week</h3>
          {currentWeekAll && weekRemaining > 0 ? (
            <span className="text-xs text-[var(--accent-orange)] font-mono">
              Resets in {formatTimeRemaining(weekRemaining)}
            </span>
          ) : null}
        </div>

        {!currentWeekAll ? (
          <p className="text-[var(--text-muted)] text-sm">No data — requires active usage window</p>
        ) : (
          <>
            <div className="text-xs text-[var(--text-muted)] mb-3">
              {formatWeekRange(currentWeekAll.weekStart, currentWeekAll.weekEnd)}
            </div>
            <TokenBreakdown
              inputTokens={currentWeekAll.inputTokens}
              outputTokens={currentWeekAll.outputTokens}
              cacheCreationTokens={currentWeekAll.cacheCreationTokens}
              cacheReadTokens={currentWeekAll.cacheReadTokens}
              totalTokens={currentWeekAll.totalTokens}
              totalCost={currentWeekAll.totalCost}
              solvedLimits={solvedLimits}
              derivedLimits={derivedLimits}
              scope="weekly-all"
              peakStatus={currentWeekAll.peakStatus ?? "peak"}
              peakSplit={currentWeekAll.peakSplit}
              windowStart={currentWeekAll.weekStart}
              promoPeriods={promoPeriods}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ─── Weekly Accordion (Section B) ────────────────────────────────────────────

interface WeeklyAccordionProps {
  buckets: WeeklyBucket[];
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  derivedLimits: DerivedLimits | null;
  overrides: SessionOverrides;
  onSaveOverride: (type: "weekly" | "5h", key: string, start: string, end: string) => Promise<void>;
}

function WeeklyAccordion({ buckets, solvedLimits, derivedLimits, overrides, onSaveOverride }: WeeklyAccordionProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<string | null>(null);

  const sorted = [...buckets].sort(
    (a, b) => new Date(b.weekStart).getTime() - new Date(a.weekStart).getTime()
  );

  if (sorted.length === 0) {
    return (
      <div className="card p-5 mb-4">
        <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Weekly Sessions</h3>
        <p className="text-[var(--text-muted)] text-sm">No weekly data available</p>
      </div>
    );
  }

  return (
    <div className="card p-5 mb-4">
      <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">Weekly Sessions</h3>
      <div className="space-y-2">
        {sorted.map((bucket) => {
          const weekKey = isoWeekKey(bucket.weekStart);
          const override = overrides.weekly[weekKey];
          const isExpanded = expanded === weekKey;
          const isCurrentWeek = bucket.timeRemainingMs > 0;

          return (
            <div key={weekKey} className="border border-[var(--border-subtle)] rounded-lg overflow-hidden">
              {/* Accordion header */}
              <button
                onClick={() => setExpanded(isExpanded ? null : weekKey)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--bg-secondary)] transition-colors text-left"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-[var(--accent-purple)]">{weekKey}</span>
                  <span className="text-xs text-[var(--text-muted)]">
                    {override
                      ? `${formatLocalDate(override.start)} – ${formatLocalDate(override.end)}`
                      : formatWeekRange(bucket.weekStart, bucket.weekEnd)}
                  </span>
                  {override && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-orange)]/20 text-[var(--accent-orange)]">
                      corrected
                    </span>
                  )}
                  {isCurrentWeek && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-green)]/20 text-[var(--accent-green)]">
                      current
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <span className="text-xs text-[var(--text-secondary)] tabular-nums flex flex-col items-end leading-tight">
                    <span>{formatTokens(bucket.totalTokens)}</span>
                    <span className="text-[9px] text-[var(--text-muted)]">{formatCost(bucket.totalCost)}</span>
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">{isExpanded ? "▲" : "▼"}</span>
                </div>
              </button>

              {/* Accordion body */}
              {isExpanded && (
                <div className="px-4 pb-4 pt-2 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50">
                  <TokenBreakdown
                    inputTokens={bucket.inputTokens}
                    outputTokens={bucket.outputTokens}
                    cacheCreationTokens={bucket.cacheCreationTokens}
                    cacheReadTokens={bucket.cacheReadTokens}
                    totalTokens={bucket.totalTokens}
                    totalCost={bucket.totalCost}
                    solvedLimits={solvedLimits}
                    derivedLimits={derivedLimits}
                    scope="weekly-all"
                    peakStatus="off-peak"
                    windowStart={bucket.weekStart}
                  />

                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]">
                    <span>{bucket.messageCount} msgs</span>
                    <span>{formatCost(bucket.totalCost)}</span>
                    <button
                      onClick={() => setEditKey(weekKey)}
                      className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-[var(--text-muted)] border border-[var(--border-subtle)] hover:border-[var(--accent-blue)] hover:text-[var(--accent-blue)] transition-colors"
                    >
                      Edit window boundaries
                    </button>
                  </div>
                </div>
              )}

              {/* Edit dialog */}
              {editKey === weekKey && (
                <EditBoundariesDialog
                  type="weekly"
                  overrideKey={weekKey}
                  initialStart={override?.start ?? bucket.weekStart}
                  initialEnd={override?.end ?? bucket.weekEnd}
                  onSave={(start, end) => onSaveOverride("weekly", weekKey, start, end)}
                  onClose={() => setEditKey(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── 5h Windows Accordion (Section C) ────────────────────────────────────────

interface FiveHourAccordionProps {
  windows: FiveHourWindow[];
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  derivedLimits: DerivedLimits | null;
  overrides: SessionOverrides;
  onSaveOverride: (type: "weekly" | "5h", key: string, start: string, end: string) => Promise<void>;
  promoPeriods?: PromoPeriod[];
}

function FiveHourAccordion({ windows, solvedLimits, derivedLimits, overrides, onSaveOverride, promoPeriods = [] }: FiveHourAccordionProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<string | null>(null);

  const sorted = [...windows].sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
  );

  if (sorted.length === 0) {
    return (
      <div className="card p-5">
        <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">5h Windows</h3>
        <p className="text-[var(--text-muted)] text-sm">No window data available</p>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">5h Windows</h3>
      <div className="space-y-2">
        {sorted.map((win) => {
          const winKey = win.startTime;
          const override = overrides["5h"][winKey];
          const isExpanded = expanded === winKey;
          const displayStart = override?.start ?? win.startTime;
          const displayEnd = override?.end ?? win.endTime;

          return (
            <div key={winKey} className="border border-[var(--border-subtle)] rounded-lg overflow-hidden">
              {/* Accordion header */}
              <button
                onClick={() => setExpanded(isExpanded ? null : winKey)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--bg-secondary)] transition-colors text-left"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-[var(--text-muted)] whitespace-nowrap">
                    {formatLocalTime(displayStart)} → {formatLocalTime(displayEnd)}
                  </span>
                  <span className="text-[10px] text-[var(--text-muted)]">
                    {formatLocalDate(win.startTime)}
                  </span>
                  {override && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-orange)]/20 text-[var(--accent-orange)]">
                      corrected
                    </span>
                  )}
                  {win.status === "active" && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-green)]/20 text-[var(--accent-green)] flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-green)] animate-pulse inline-block" />
                      active
                    </span>
                  )}
                  {win.peakStatus === "peak" && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-red)]/20 text-[var(--accent-red)]">
                      peak
                    </span>
                  )}
                  {getWindowPromoMultiplier(win, promoPeriods) > 1 && win.peakStatus === "off-peak" && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-orange)]/20 text-[var(--accent-orange)]">
                      promo
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <span className="text-xs text-[var(--text-secondary)] tabular-nums flex flex-col items-end leading-tight">
                    <span>{formatTokens(win.totalTokens)}</span>
                    <span className="text-[9px] text-[var(--text-muted)]">{formatCost(win.totalCost)}</span>
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">{isExpanded ? "▲" : "▼"}</span>
                </div>
              </button>

              {/* Accordion body */}
              {isExpanded && (
                <div className="px-4 pb-4 pt-2 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50">
                  <TokenBreakdown
                    inputTokens={win.inputTokens}
                    outputTokens={win.outputTokens}
                    cacheCreationTokens={win.cacheCreationTokens}
                    cacheReadTokens={win.cacheReadTokens}
                    totalTokens={win.totalTokens}
                    totalCost={win.totalCost}
                    solvedLimits={solvedLimits}
                    derivedLimits={derivedLimits}
                    scope="5h"
                    peakStatus={win.peakStatus}
                    windowStart={win.startTime}
                  />

                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]">
                    <span>{win.messageCount} msgs / {win.sessionIds.length} sessions</span>
                    <div className="flex items-center gap-3">
                      <span>{formatCost(win.totalCost)}</span>
                      <button
                        onClick={() => setEditKey(winKey)}
                        className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-[var(--text-muted)] border border-[var(--border-subtle)] hover:border-[var(--accent-blue)] hover:text-[var(--accent-blue)] transition-colors"
                      >
                        Edit window boundaries
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Edit dialog */}
              {editKey === winKey && (
                <EditBoundariesDialog
                  type="5h"
                  overrideKey={winKey}
                  initialStart={override?.start ?? win.startTime}
                  initialEnd={override?.end ?? win.endTime}
                  onSave={(start, end) => onSaveOverride("5h", winKey, start, end)}
                  onClose={() => setEditKey(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── WeeklyWindowsView — weekly accordion (open by default) with 5h progress bars ──

type ViewMode = "output" | "total";

interface WindowRowProps {
  win: FiveHourWindow;
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  derivedLimits: DerivedLimits | null;
  calibrations: CalibrationPoint[];
  overrides: SessionOverrides;
  onEditBoundaries: (winKey: string) => void;
  viewMode: ViewMode;
  maxTokens: number;
  promoPeriods?: PromoPeriod[];
  planMultiplier?: number;
  calibrationAnchor?: CalibrationPoint;
}

function WindowRow({
  win,
  solvedLimits,
  derivedLimits,
  calibrations,
  overrides,
  onEditBoundaries,
  viewMode,
  maxTokens,
  promoPeriods = [],
  planMultiplier = 1,
  calibrationAnchor,
}: WindowRowProps) {
  const [expanded, setExpanded] = useState(false);

  const override = overrides["5h"][win.startTime];
  const displayStart = override?.start ?? win.startTime;
  const displayEnd = override?.end ?? win.endTime;

  // Compute utilization
  let displayPct: number | null = null;
  let bottleneckColor = "var(--accent-blue)";
  let bottleneckLabel = "";
  let isCalibrated = false;
  let basePct: number | null = null;

  // Try solvedLimits first
  if (solvedLimits && solvedLimits["5h"].best.confidence > 0) {
    const est = estimateUtilization(
      {
        output: win.outputTokens,
        input: win.inputTokens,
        cacheWrite: win.cacheCreationTokens,
        cacheRead: win.cacheReadTokens,
        total: win.totalTokens,
      },
      win.totalCost,
      solvedLimits["5h"],
      win.peakStatus,
      win.startTime,
      win.peakSplit,
      promoPeriods,
      planMultiplier,
      calibrationAnchor
    );
    if (est) {
      displayPct = est.estimatedPct;
      bottleneckColor = BOTTLENECK_COLORS[est.bottleneck as keyof typeof BOTTLENECK_COLORS] ?? "var(--accent-blue)";
      bottleneckLabel = BOTTLENECK_LABELS[est.bottleneck as keyof typeof BOTTLENECK_LABELS] ?? "";
    }
  }

  // Fallback: derivedLimits
  if (displayPct === null && derivedLimits) {
    const util = calcUtilization(
      { outputTokens: win.outputTokens, inputTokens: win.inputTokens, totalTokens: win.totalTokens },
      derivedLimits,
      win.peakStatus,
      win.startTime,
      "5h",
      win.peakSplit,
      promoPeriods,
      planMultiplier
    );
    if (util) {
      displayPct = util.effectivePct;
      bottleneckColor = BOTTLENECK_COLORS[util.bottleneck as keyof typeof BOTTLENECK_COLORS] ?? "var(--accent-blue)";
      bottleneckLabel = BOTTLENECK_LABELS[util.bottleneck as keyof typeof BOTTLENECK_LABELS] ?? "";
    }
  }

  // Check if calibrated for this window
  const cal = getCalibrationForWindow(win.id, calibrations);
  isCalibrated = !!cal;

  const promoMultiplier = getWindowPromoMultiplier(win, promoPeriods);
  if (displayPct !== null && promoMultiplier > 1) {
    basePct = displayPct * promoMultiplier;
  }

  const tokens = viewMode === "output" ? win.outputTokens : win.totalTokens;
  const barWidth = displayPct !== null
    ? Math.min(displayPct, 100)
    : (tokens / maxTokens) * 100;

  const barColor = win.status === "active"
    ? "var(--accent-green)"
    : win.peakStatus === "peak"
    ? "var(--accent-red)"
    : "var(--accent-blue)";

  return (
    <div className="border-b border-[var(--border-subtle)] last:border-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-2.5 hover:bg-[var(--bg-secondary)]/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {/* Date + Time */}
          <span className="w-32 text-[11px] text-[var(--text-muted)] tabular-nums shrink-0 flex flex-col leading-tight">
            <span className="text-[9px] opacity-70">{formatShortDate(displayStart)}</span>
            <span>{formatLocalTime(displayStart)}–{formatLocalTime(displayEnd)}</span>
          </span>

          {/* Progress bar */}
          <div className="flex-1 h-5 bg-[var(--bg-primary)] rounded overflow-hidden relative">
            {promoMultiplier > 1 && displayPct !== null ? (
              <>
                <div
                  className="absolute inset-y-0 left-0 rounded-l transition-all duration-300"
                  style={{ width: `${Math.max(barWidth, 2)}%`, background: barColor, opacity: 0.85 }}
                />
                <div
                  className="absolute inset-y-0 transition-all duration-300"
                  style={{
                    left: `${barWidth}%`,
                    width: `${Math.min((basePct ?? 0) - barWidth, 100 - barWidth)}%`,
                    background: barColor,
                    opacity: 0.3,
                  }}
                />
              </>
            ) : (
              <div
                className="h-full rounded transition-all duration-300"
                style={{ width: `${Math.max(barWidth, 2)}%`, background: barColor, opacity: 0.8 }}
              />
            )}
          </div>

          {/* % label */}
          {displayPct !== null ? (
            <span
              className="w-32 text-right text-[11px] tabular-nums shrink-0 font-medium"
              style={{ color: bottleneckColor }}
            >
              {isCalibrated && <span className="text-[8px] text-[var(--accent-green)] mr-0.5">●</span>}
              {basePct !== null ? (
                <>
                  {displayPct.toFixed(0)}%{" "}
                  <span className="text-[var(--accent-orange)]">
                    ({basePct.toFixed(0)}%<span className="text-[9px]"> Bonus {promoMultiplier}x</span>)
                  </span>
                </>
              ) : (
                <>
                  {displayPct.toFixed(0)}%
                  <span className="text-[9px] opacity-70 ml-0.5">{bottleneckLabel}</span>
                </>
              )}
            </span>
          ) : (
            <span className="w-32 text-right text-[11px] text-[var(--text-muted)] tabular-nums shrink-0">
              {formatTokens(tokens)}
            </span>
          )}

          <span className="w-24 text-right text-[11px] text-[var(--text-secondary)] tabular-nums shrink-0 flex flex-col leading-tight">
            <span>{formatTokens(tokens)}</span>
            <span className="text-[9px] text-[var(--text-muted)]">{formatCost(win.totalCost)}</span>
          </span>
        </div>
      </button>

      {expanded && (
        <div className="ml-4 px-4 pb-3 pt-1 bg-[var(--bg-secondary)]/40 animate-fade-in">
          <TokenBreakdown
            inputTokens={win.inputTokens}
            outputTokens={win.outputTokens}
            cacheCreationTokens={win.cacheCreationTokens}
            cacheReadTokens={win.cacheReadTokens}
            totalTokens={win.totalTokens}
            totalCost={win.totalCost}
            solvedLimits={solvedLimits}
            derivedLimits={derivedLimits}
            scope="5h"
            peakStatus={win.peakStatus}
            peakSplit={win.peakSplit}
            windowStart={win.startTime}
            promoPeriods={promoPeriods}
            planMultiplier={planMultiplier}
          />

          {/* Meta row */}
          <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)] pt-2 border-t border-[var(--border-subtle)]">
            <span>
              {win.messageCount} msgs / {win.sessionIds.length} sessions
              {override && <span className="ml-2 text-[var(--accent-orange)]">· boundary corrected</span>}
            </span>
            <div className="flex items-center gap-3">
              <span>{formatTokens(win.totalTokens)} total · {formatCost(win.totalCost)}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onEditBoundaries(win.startTime); }}
                className="px-2 py-1 rounded text-[10px] border border-[var(--border-subtle)] hover:border-[var(--accent-blue)] hover:text-[var(--accent-blue)] transition-colors"
              >
                Edit boundaries
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface WeeklyWindowsViewProps {
  windows: FiveHourWindow[];
  weeklyAll: WeeklyBucket[];
  weeklySonnet: WeeklyBucket[];
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  derivedLimits: DerivedLimits | null;
  calibrations: CalibrationPoint[];
  overrides: SessionOverrides;
  onSaveOverride: (type: "weekly" | "5h", key: string, start: string, end: string) => Promise<void>;
  planPeriods?: PlanPeriod[];
  promoPeriods?: PromoPeriod[];
}

/** Monday 00:00 – Sunday 23:59 (local time) for the ISO week containing dateStr */
function getWeekDateRange(dateStr: string): { start: Date; end: Date } {
  const d = new Date(dateStr);
  const day = d.getDay() || 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - day + 1);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 0, 0);
  return { start: monday, end: sunday };
}

function WeeklyWindowsView({
  windows,
  weeklyAll,
  weeklySonnet,
  solvedLimits,
  derivedLimits,
  calibrations,
  overrides,
  onSaveOverride,
  planPeriods,
  promoPeriods = [],
}: WeeklyWindowsViewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("output");
  const [editKey, setEditKey] = useState<string | null>(null);
  const sorted = [...windows].sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const maxTokens = Math.max(
    ...sorted.map((w) => (viewMode === "output" ? w.outputTokens : w.totalTokens)),
    1
  );

  const overlapMs = (
    aStart: string,
    aEnd: string,
    bStart: string,
    bEnd: string
  ): number => {
    const start = Math.max(new Date(aStart).getTime(), new Date(bStart).getTime());
    const end = Math.min(new Date(aEnd).getTime(), new Date(bEnd).getTime());
    return Math.max(0, end - start);
  };

  const formatPromoMultiplier = (value: number): string =>
    Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/\.?0+$/, "");

  const computeBucketEstimate = (
    bucket: WeeklyBucket | null,
    scope: "weekly-all" | "weekly-sonnet",
    planMult: number = 1,
    anchor?: CalibrationPoint
  ): {
    displayPct: number;
    basePct: number | null;
    color: string;
    label: string;
    promoMultiplier: number;
  } | null => {
    if (!bucket) return null;

    const peakStatus = bucket.peakStatus ?? "peak";
    const peakSplit = bucket.peakSplit;
    const promoMultiplier = getWeeklyPromoMultiplier(bucket, promoPeriods);

    const solved = solvedLimits?.[scope];
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
        peakStatus,
        bucket.weekStart,
        peakSplit,
        promoPeriods,
        planMult,
        anchor
      );
      if (est) {
        return {
          displayPct: est.estimatedPct,
          basePct: promoMultiplier > 1 ? est.estimatedPct * promoMultiplier : null,
          color:
            BOTTLENECK_COLORS[est.bottleneck as keyof typeof BOTTLENECK_COLORS] ??
            "var(--accent-orange)",
          label:
            BOTTLENECK_LABELS[est.bottleneck as keyof typeof BOTTLENECK_LABELS] ??
            "",
          promoMultiplier,
        };
      }
    }

    if (derivedLimits) {
      const util = calcUtilization(
        {
          outputTokens: bucket.outputTokens,
          inputTokens: bucket.inputTokens,
          totalTokens: bucket.totalTokens,
        },
        derivedLimits,
        peakStatus,
        bucket.weekStart,
        "weekly",
        peakSplit,
        promoPeriods,
        planMult
      );
      if (util) {
        return {
          displayPct: util.effectivePct,
          basePct: promoMultiplier > 1 ? util.effectivePct * promoMultiplier : null,
          color:
            BOTTLENECK_COLORS[util.bottleneck as keyof typeof BOTTLENECK_COLORS] ??
            "var(--accent-orange)",
          label:
            BOTTLENECK_LABELS[util.bottleneck as keyof typeof BOTTLENECK_LABELS] ??
            "",
          promoMultiplier,
        };
      }
    }

    return null;
  };

  const groups = [...weeklyAll]
    .sort(
      (a, b) => new Date(b.weekStart).getTime() - new Date(a.weekStart).getTime()
    )
    .map((allBucket) => {
      const wins = sorted.filter((win) => {
        const start = new Date(win.startTime).getTime();
        return (
          start >= new Date(allBucket.weekStart).getTime() &&
          start < new Date(allBucket.weekEnd).getTime()
        );
      });

      const sonnetBucket =
        [...weeklySonnet].sort(
          (a, b) =>
            overlapMs(allBucket.weekStart, allBucket.weekEnd, b.weekStart, b.weekEnd) -
            overlapMs(allBucket.weekStart, allBucket.weekEnd, a.weekStart, a.weekEnd)
        )[0] ?? null;

      const weekPlanTier = planPeriods
        ? getPlanTierForDate(allBucket.weekStart, planPeriods)
        : null;
      const weekPlanInfo = weekPlanTier ? PLAN_TIERS[weekPlanTier] : null;
      const allOverride = getWeeklyOverrideMatch(overrides, allBucket, "all");
      const resolvedSonnetBucket =
        sonnetBucket &&
        overlapMs(
          allBucket.weekStart,
          allBucket.weekEnd,
          sonnetBucket.weekStart,
          sonnetBucket.weekEnd
        ) > 0
          ? sonnetBucket
          : null;
      const sonnetOverride = resolvedSonnetBucket
        ? getWeeklyOverrideMatch(overrides, resolvedSonnetBucket, "sonnet")
        : null;

      const planMult = weekPlanInfo?.multiplier ?? 1;

      // Find calibration anchors for this week
      const allAnchor = findCalibrationAnchor(calibrations, "weekly-all", allBucket.weekStart);
      const sonnetAnchor = resolvedSonnetBucket
        ? findCalibrationAnchor(calibrations, "weekly-sonnet", resolvedSonnetBucket.weekStart)
        : undefined;

      return {
        key: allBucket.weekStart,
        weekKey: weekKeyFromDate(allBucket.weekStart),
        allBucket,
        sonnetBucket: resolvedSonnetBucket,
        wins,
        allEst: computeBucketEstimate(allBucket, "weekly-all", planMult, allAnchor),
        sonnetEst: computeBucketEstimate(
          resolvedSonnetBucket,
          "weekly-sonnet",
          planMult,
          sonnetAnchor
        ),
        weekPlanInfo,
        planMultiplier: planMult,
        allOverride,
        sonnetOverride,
      };
    })
    .filter((group) => group.wins.length > 0 || group.allBucket.timeRemainingMs > 0);

  const renderWeeklyBar = (
    tag: string,
    est: {
      displayPct: number;
      basePct: number | null;
      color: string;
      label: string;
      promoMultiplier: number;
    } | null
  ) => (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-6 bg-[var(--bg-primary)] rounded overflow-hidden relative">
        {est &&
          (est.basePct !== null ? (
            <>
              <div
                className="absolute inset-y-0 left-0 rounded-l transition-all duration-300"
                style={{
                  width: `${Math.max(Math.min(est.displayPct, 100), 2)}%`,
                  background: est.color,
                  opacity: 0.8,
                }}
              />
              <div
                className="absolute inset-y-0 rounded-r transition-all duration-300"
                style={{
                  left: `${Math.max(Math.min(est.displayPct, 100), 2)}%`,
                  width: `${Math.max(
                    0,
                    Math.min(
                      (est.basePct ?? 0) - Math.max(Math.min(est.displayPct, 100), 2),
                      100 - Math.max(Math.min(est.displayPct, 100), 2)
                    )
                  )}%`,
                  background: est.color,
                  opacity: 0.3,
                }}
              />
            </>
          ) : (
            <div
              className="h-full rounded transition-all duration-300"
              style={{
                width: `${Math.max(Math.min(est.displayPct, 100), 2)}%`,
                background: est.color,
                opacity: 0.75,
              }}
            />
          ))}
        <span className="absolute inset-y-0 left-2 flex items-center text-[9px] font-medium text-white/50 uppercase tracking-wider pointer-events-none">
          {tag}
        </span>
      </div>
      {est && (
        <span
          className="w-32 text-right text-[11px] font-semibold tabular-nums shrink-0"
          style={{ color: est.color }}
        >
          {est.basePct !== null ? (
            <>
              {est.displayPct.toFixed(0)}%
              <span className="text-[var(--accent-orange)] ml-1">
                ({est.basePct.toFixed(0)}%
                <span className="text-[9px]">
                  {" "}
                  Bonus {formatPromoMultiplier(est.promoMultiplier)}x
                </span>
                )
              </span>
            </>
          ) : (
            <>
              {est.displayPct.toFixed(0)}%
              <span className="text-[9px] font-normal opacity-70 ml-0.5">
                {est.label}
              </span>
            </>
          )}
        </span>
      )}
    </div>
  );

  if (sorted.length === 0) {
    return (
      <div className="card p-5">
        <p className="text-[var(--text-muted)] text-sm">No window data available</p>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-[var(--text-secondary)]">
          Weekly Sessions + 5h Windows
        </h3>
        <div className="flex gap-1 bg-[var(--bg-secondary)] rounded-md p-0.5">
          {(["output", "total"] as ViewMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={`px-2.5 py-1 rounded text-[10px] font-medium transition-all ${
                viewMode === m
                  ? "bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              {m === "output" ? "Output" : "Total"}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {groups.map(
          ({
            key,
            weekKey,
            allBucket,
            sonnetBucket,
            wins,
            allEst,
            sonnetEst,
            weekPlanInfo,
            planMultiplier: groupPlanMult,
            allOverride,
            sonnetOverride,
          }) => {
            const isCollapsed = collapsed.has(key);
            const planAccentColor = weekPlanInfo?.color ?? null;

            return (
              <div
                key={key}
                className="border rounded-lg overflow-hidden"
                style={{
                  borderColor: planAccentColor
                    ? `color-mix(in srgb, ${planAccentColor} 35%, var(--border-subtle))`
                    : "var(--border-subtle)",
                }}
              >
                <button
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (isCollapsed) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-[var(--bg-secondary)] transition-colors text-left"
                  style={{
                    background: planAccentColor
                      ? `color-mix(in srgb, ${planAccentColor} 6%, var(--bg-secondary))`
                      : "color-mix(in srgb, var(--bg-secondary) 60%, transparent)",
                  }}
                >
                  <div className="flex flex-col shrink-0 w-36 leading-tight">
                    <div className="flex items-center gap-1">
                      <span
                        className="text-[9px] font-semibold tabular-nums"
                        style={{ color: planAccentColor ?? "var(--accent-purple)" }}
                      >
                        {weekKey}
                      </span>
                      {weekPlanInfo && (
                        <span
                          className="text-[9px] px-1 rounded font-semibold"
                          style={{
                            color: weekPlanInfo.color,
                            background: `color-mix(in srgb, ${weekPlanInfo.color} 18%, transparent)`,
                          }}
                        >
                          {weekPlanInfo.shortLabel}
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
                      ALL {formatWeekRange(allOverride?.entry.start ?? allBucket.weekStart, allOverride?.entry.end ?? allBucket.weekEnd)}
                    </span>
                    {sonnetBucket && (
                      <span className="text-[10px] text-[var(--text-muted)]/80 tabular-nums">
                        S {formatWeekRange(sonnetOverride?.entry.start ?? sonnetBucket.weekStart, sonnetOverride?.entry.end ?? sonnetBucket.weekEnd)}
                      </span>
                    )}
                  </div>

                  <div className="flex-1 flex flex-col gap-1 min-w-0">
                    {renderWeeklyBar("ALL", allEst)}
                    {renderWeeklyBar("SNNT", sonnetEst)}
                  </div>

                  <div className="flex items-center gap-2 shrink-0 ml-1">
                    <span className="text-[11px] text-[var(--text-secondary)] tabular-nums flex flex-col items-end leading-tight">
                      <span>
                        {formatTokens(
                          viewMode === "output"
                            ? allBucket.outputTokens
                            : allBucket.totalTokens
                        )}
                      </span>
                      <span className="text-[9px] text-[var(--text-muted)]">
                        {formatCost(allBucket.totalCost)}
                      </span>
                    </span>
                    <span className="text-[10px] text-[var(--text-muted)]">
                      {wins.length} win
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">
                      {isCollapsed ? "▶" : "▼"}
                    </span>
                  </div>
                </button>

                {!isCollapsed && (
                  <div>
                    {wins.map((win) => (
                      <WindowRow
                        key={win.id}
                        win={win}
                        solvedLimits={solvedLimits}
                        derivedLimits={derivedLimits}
                        calibrations={calibrations}
                        overrides={overrides}
                        onEditBoundaries={setEditKey}
                        viewMode={viewMode}
                        maxTokens={maxTokens}
                        promoPeriods={promoPeriods}
                        planMultiplier={groupPlanMult}
                        calibrationAnchor={findCalibrationAnchor(calibrations, "5h", win.startTime)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          }
        )}
      </div>

      <div className="flex flex-wrap gap-3 mt-4 pt-3 border-t border-[var(--border-subtle)] justify-center text-[10px] text-[var(--text-muted)]">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--accent-green)]" />
          Active
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--accent-blue)]" />
          Off-peak
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--accent-red)]" />
          Peak
        </span>
        <span className="border-l border-[var(--border-subtle)] pl-3 flex items-center gap-1">
          <span className="w-3 h-2 rounded-sm bg-[var(--accent-blue)]" style={{ opacity: 0.85 }} />
          <span className="w-3 h-2 rounded-sm bg-[var(--accent-blue)]" style={{ opacity: 0.3 }} />
          Bonus 2x
        </span>
        <span className="flex items-center gap-1">
          <span className="text-[var(--accent-green)]">●</span>
          Calibrated
        </span>
      </div>

      {editKey &&
        (() => {
          const win = windows.find((w) => w.startTime === editKey);
          if (!win) return null;
          const override = overrides["5h"][editKey];
          return (
            <EditBoundariesDialog
              type="5h"
              overrideKey={editKey}
              initialStart={override?.start ?? win.startTime}
              initialEnd={override?.end ?? win.endTime}
              onSave={(start, end) => onSaveOverride("5h", editKey, start, end)}
              onClose={() => setEditKey(null)}
            />
          );
        })()}
    </div>
  );
}

// ─── Main LimitsTab Component ─────────────────────────────────────────────────

interface LimitsTabProps {
  limitsData: LimitsData;
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  derivedLimits: DerivedLimits | null;
  calibrations: CalibrationPoint[];
  planPeriods?: PlanPeriod[];
  promoPeriods?: PromoPeriod[];
}

export function LimitsTab({ limitsData, solvedLimits, derivedLimits, calibrations, planPeriods, promoPeriods = [] }: LimitsTabProps) {
  const [overrides, setOverrides] = useState<SessionOverrides>({ weekly: {}, "5h": {} });

  const fetchOverrides = useCallback(async () => {
    try {
      const res = await fetch("/api/session-overrides", { cache: "no-store" });
      if (res.ok) {
        setOverrides(await res.json());
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchOverrides();
  }, [fetchOverrides]);

  const handleSaveOverride = async (
    type: "weekly" | "5h",
    key: string,
    start: string,
    end: string
  ) => {
    await fetch("/api/session-overrides", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, key, start, end }),
    });
    await fetchOverrides();
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Section A: Status cards */}
      <StatusCards
        currentWindow={limitsData.currentWindow}
        currentWeekAll={limitsData.currentWeekAll}
        solvedLimits={solvedLimits}
        derivedLimits={derivedLimits}
        promoPeriods={promoPeriods}
      />

      {/* Section B+C: Weekly groups with 5h windows inside, progress bars, expanded by default */}
      <WeeklyWindowsView
        windows={limitsData.windows}
        weeklyAll={limitsData.weeklyAll}
        weeklySonnet={limitsData.weeklySonnet}
        solvedLimits={solvedLimits}
        derivedLimits={derivedLimits}
        calibrations={calibrations}
        overrides={overrides}
        onSaveOverride={handleSaveOverride}
        planPeriods={planPeriods}
        promoPeriods={promoPeriods}
      />
    </div>
  );
}
