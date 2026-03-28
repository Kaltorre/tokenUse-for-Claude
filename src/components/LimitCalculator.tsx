"use client";

import { useState, useEffect, useCallback } from "react";
import { FiveHourWindow, WeeklyBucket, DerivedLimits, PromoPeriod } from "@/lib/types";
import { formatTokens } from "@/lib/format";
import { saveDerivedLimits, isInPromoRange, isInPromoSchedule } from "@/lib/utilization";

interface Props {
  currentWindow: FiveHourWindow | null;
  currentWeekAll: WeeklyBucket | null;
  currentWeekSonnet: WeeklyBucket | null;
  derivedLimits: DerivedLimits | null;
  onLimitsChange: (limits: DerivedLimits) => void;
  promoPeriods?: PromoPeriod[];
}

type CalcTarget = "5h" | "weekly-all" | "weekly-sonnet";

interface DerivedLimit {
  label: string;
  tokens: number;
  basedOn: string;
  baseTokens: number; // without promo
}

function deriveLimit(tokens: number, percent: number): number {
  if (percent <= 0 || percent > 100) return 0;
  return Math.round(tokens / (percent / 100));
}

export function LimitCalculator({
  currentWindow,
  currentWeekAll,
  currentWeekSonnet,
  derivedLimits,
  onLimitsChange,
  promoPeriods = [],
}: Props) {
  const [percent, setPercent] = useState<string>(
    derivedLimits?.calibrationPct?.toString() ?? ""
  );
  const [target, setTarget] = useState<CalcTarget>("5h");
  const [initialized, setInitialized] = useState(false);

  // Sync percent from loaded limits (localStorage loads async)
  useEffect(() => {
    if (!initialized && derivedLimits?.calibrationPct && !percent) {
      setPercent(derivedLimits.calibrationPct.toString());
      setInitialized(true);
    }
  }, [derivedLimits, initialized, percent]);

  const pct = parseFloat(percent);
  const isValid = !isNaN(pct) && pct > 0 && pct <= 100;

  // Select source data based on target
  const source =
    target === "5h"
      ? currentWindow
      : target === "weekly-all"
      ? currentWeekAll
      : currentWeekSonnet;

  const sourceLabel =
    target === "5h"
      ? "Current 5h Window"
      : target === "weekly-all"
      ? "Weekly (All Models)"
      : "Weekly (Sonnet)";

  // Determine if current window is during off-peak promo
  const startTime = currentWindow?.startTime ?? "";
  const isPromo =
    target === "5h" &&
    currentWindow?.peakStatus === "off-peak" &&
    (promoPeriods.length > 0 ? isInPromoSchedule(startTime, promoPeriods) : isInPromoRange(startTime));

  const weeklySource =
    target === "weekly-all" ? currentWeekAll : currentWeekSonnet;
  const isWeeklyPromo =
    target !== "5h" &&
    weeklySource &&
    (promoPeriods.length > 0 ? isInPromoSchedule(weeklySource.weekStart, promoPeriods) : isInPromoRange(weeklySource.weekStart));

  // Calculate derived limits
  const derived: DerivedLimit[] =
    source && isValid
      ? [
          {
            label: "Output only",
            tokens: deriveLimit(source.outputTokens, pct),
            basedOn: `${formatTokens(source.outputTokens)} output`,
            baseTokens: isPromo
              ? Math.round(deriveLimit(source.outputTokens, pct) / 2)
              : deriveLimit(source.outputTokens, pct),
          },
          {
            label: "Input + Output",
            tokens: deriveLimit(
              source.inputTokens + source.outputTokens,
              pct
            ),
            basedOn: `${formatTokens(source.inputTokens + source.outputTokens)} in+out`,
            baseTokens: isPromo
              ? Math.round(
                  deriveLimit(source.inputTokens + source.outputTokens, pct) / 2
                )
              : deriveLimit(source.inputTokens + source.outputTokens, pct),
          },
          {
            label: "Total (all types)",
            tokens: deriveLimit(source.totalTokens, pct),
            basedOn: `${formatTokens(source.totalTokens)} total`,
            baseTokens: isPromo
              ? Math.round(deriveLimit(source.totalTokens, pct) / 2)
              : deriveLimit(source.totalTokens, pct),
          },
        ]
      : [];

  // Auto-save to localStorage when limits are derived
  const handleSave = useCallback(() => {
    if (derived.length !== 3 || !isValid) return;

    const newLimits: DerivedLimits = {
      outputLimit: derived[0].baseTokens,
      inputOutputLimit: derived[1].baseTokens,
      totalLimit: derived[2].baseTokens,
      weeklyOutputLimit: derivedLimits?.weeklyOutputLimit ?? null,
      weeklyInputOutputLimit: derivedLimits?.weeklyInputOutputLimit ?? null,
      weeklyTotalLimit: derivedLimits?.weeklyTotalLimit ?? null,
      calibratedAt: new Date().toISOString(),
      calibrationPct: pct,
      promoActive: isPromo || false,
    };

    // If calibrating weekly, save weekly limits instead
    if (target === "weekly-all" || target === "weekly-sonnet") {
      newLimits.weeklyOutputLimit = isWeeklyPromo
        ? Math.round(derived[0].tokens / 2)
        : derived[0].tokens;
      newLimits.weeklyInputOutputLimit = isWeeklyPromo
        ? Math.round(derived[1].tokens / 2)
        : derived[1].tokens;
      newLimits.weeklyTotalLimit = isWeeklyPromo
        ? Math.round(derived[2].tokens / 2)
        : derived[2].tokens;
      // Keep existing 5h limits
      newLimits.outputLimit = derivedLimits?.outputLimit ?? derived[0].baseTokens;
      newLimits.inputOutputLimit = derivedLimits?.inputOutputLimit ?? derived[1].baseTokens;
      newLimits.totalLimit = derivedLimits?.totalLimit ?? derived[2].baseTokens;
    }

    saveDerivedLimits(newLimits);
    onLimitsChange(newLimits);
  }, [derived, isValid, pct, isPromo, isWeeklyPromo, target, derivedLimits, onLimitsChange, promoPeriods]);

  // Save on percent change (debounced via derived)
  useEffect(() => {
    if (derived.length === 3) {
      handleSave();
    }
  }, [pct, target]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-[var(--text-secondary)]">
          Limit Derivation Calculator
        </h3>
        {derivedLimits && (
          <span className="text-[10px] text-[var(--accent-green)]">
            Saved
          </span>
        )}
      </div>

      {/* Target selector */}
      <div className="flex gap-1 bg-[var(--bg-secondary)] rounded-md p-0.5 mb-4">
        {(
          [
            ["5h", "5h Window"],
            ["weekly-all", "Weekly All"],
            ["weekly-sonnet", "Weekly Sonnet"],
          ] as [CalcTarget, string][]
        ).map(([val, label]) => (
          <button
            key={val}
            onClick={() => setTarget(val)}
            className={`flex-1 px-2 py-1.5 rounded text-[10px] font-medium transition-all ${
              target === val
                ? "bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Input */}
      <div className="mb-4">
        <label className="block text-xs text-[var(--text-muted)] mb-1.5">
          Claude shows (% used for {sourceLabel}):
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min="1"
            max="100"
            step="1"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            placeholder="e.g. 18"
            className="flex-1 bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
          />
          <span className="text-sm text-[var(--text-muted)]">%</span>
        </div>
        {pct > 0 && pct < 5 && (
          <p className="text-[10px] text-[var(--accent-orange)] mt-1">
            Low % — derived limits have wide confidence interval
          </p>
        )}
      </div>

      {/* No data warning */}
      {!source && (
        <p className="text-xs text-[var(--text-muted)] mb-4">
          No data available for {sourceLabel}. Use Claude to generate some usage
          first.
        </p>
      )}

      {/* Results */}
      {derived.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-2">
            Derived Limits (if {pct}% ={" "}
            {source ? formatTokens(source.totalTokens) : "?"} tokens)
          </div>

          {derived.map((d) => (
            <div
              key={d.label}
              className="flex items-center justify-between p-2.5 bg-[var(--bg-secondary)] rounded-lg"
            >
              <div>
                <span className="text-xs text-[var(--text-secondary)]">
                  {d.label}
                </span>
                <span className="text-[10px] text-[var(--text-muted)] ml-2">
                  ({d.basedOn})
                </span>
              </div>
              <div className="text-right">
                <span className="text-sm font-medium text-[var(--text-primary)] tabular-nums">
                  {formatTokens(d.tokens)}
                </span>
                {(isPromo || isWeeklyPromo) && (
                  <div className="text-[10px] text-[var(--accent-orange)]">
                    Base: {formatTokens(d.baseTokens)} (2x promo active)
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Promo notice */}
          {(isPromo || isWeeklyPromo) && (
            <div className="mt-2 p-2 rounded-lg bg-[var(--accent-orange)]/10 text-[10px] text-[var(--accent-orange)]">
              Off-peak 2x promotion active (March 13–28). Base limits shown are
              derived limit / 2.
            </div>
          )}

          {/* Saved limits summary */}
          {derivedLimits && (
            <div className="mt-3 p-2.5 rounded-lg border border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]">
              <div className="font-medium text-[var(--text-secondary)] mb-1">
                Saved Base Limits (used for % calculations)
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  OUT: {formatTokens(derivedLimits.outputLimit)}
                </div>
                <div>
                  I/O: {formatTokens(derivedLimits.inputOutputLimit)}
                </div>
                <div>
                  TOT: {formatTokens(derivedLimits.totalLimit)}
                </div>
              </div>
              {derivedLimits.weeklyOutputLimit != null && (
                <div className="grid grid-cols-3 gap-2 mt-1 pt-1 border-t border-[var(--border-subtle)]">
                  <div>
                    W-OUT: {formatTokens(derivedLimits.weeklyOutputLimit)}
                  </div>
                  <div>
                    W-I/O: {formatTokens(derivedLimits.weeklyInputOutputLimit!)}
                  </div>
                  <div>
                    W-TOT: {formatTokens(derivedLimits.weeklyTotalLimit!)}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
