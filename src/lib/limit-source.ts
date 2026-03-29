import {
  CalibrationScope,
  DEFAULT_LIMITS_5H,
  DEFAULT_LIMITS_WEEKLY,
  DerivedLimits,
  LimitOverridesMap,
  PlanTier,
  PLAN_TIERS,
  SolvedLimits,
} from "./types";

export type LimitSourceMode = "calibrated" | "manual";

const STORAGE_KEY = "claude-limit-source-mode";
const MAX20_MULTIPLIER = PLAN_TIERS.max20.multiplier;
const OVERRIDE_TIER_ORDER: PlanTier[] = ["max20", "max5", "team", "pro"];

function scaleFromTierToMax20(tier: PlanTier): number {
  const tierMultiplier = PLAN_TIERS[tier].multiplier;
  return tierMultiplier > 0 ? MAX20_MULTIPLIER / tierMultiplier : 1;
}

function inferBaseFieldFromOverrides(
  overrides: LimitOverridesMap,
  scope: "5h" | "weekly",
  field: "costLimit" | "outputLimit" | "inputOutputLimit" | "totalLimit"
): number | null {
  for (const tier of OVERRIDE_TIER_ORDER) {
    const entry = overrides[`${tier}:${scope}`];
    const value = entry?.[field];
    if (value == null) continue;
    return value * scaleFromTierToMax20(tier);
  }
  return null;
}

export function loadLimitSourceMode(): LimitSourceMode {
  if (typeof window === "undefined") return "calibrated";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "manual" ? "manual" : "calibrated";
  } catch {
    return "calibrated";
  }
}

export function saveLimitSourceMode(mode: LimitSourceMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {}
}

export function buildManualBaseDerivedLimits(
  derivedLimits: DerivedLimits | null,
  overrides: LimitOverridesMap
): DerivedLimits {
  return {
    outputLimit:
      inferBaseFieldFromOverrides(overrides, "5h", "outputLimit") ??
      derivedLimits?.outputLimit ??
      DEFAULT_LIMITS_5H.outputLimit,
    inputOutputLimit:
      inferBaseFieldFromOverrides(overrides, "5h", "inputOutputLimit") ??
      derivedLimits?.inputOutputLimit ??
      DEFAULT_LIMITS_5H.inputOutputLimit,
    totalLimit:
      inferBaseFieldFromOverrides(overrides, "5h", "totalLimit") ??
      derivedLimits?.totalLimit ??
      DEFAULT_LIMITS_5H.totalLimit,
    costLimit:
      inferBaseFieldFromOverrides(overrides, "5h", "costLimit") ??
      derivedLimits?.costLimit ??
      DEFAULT_LIMITS_5H.costLimit,
    weeklyOutputLimit:
      inferBaseFieldFromOverrides(overrides, "weekly", "outputLimit") ??
      derivedLimits?.weeklyOutputLimit ??
      DEFAULT_LIMITS_WEEKLY.outputLimit,
    weeklyInputOutputLimit:
      inferBaseFieldFromOverrides(overrides, "weekly", "inputOutputLimit") ??
      derivedLimits?.weeklyInputOutputLimit ??
      DEFAULT_LIMITS_WEEKLY.inputOutputLimit,
    weeklyTotalLimit:
      inferBaseFieldFromOverrides(overrides, "weekly", "totalLimit") ??
      derivedLimits?.weeklyTotalLimit ??
      DEFAULT_LIMITS_WEEKLY.totalLimit,
    weeklyCostLimit:
      inferBaseFieldFromOverrides(overrides, "weekly", "costLimit") ??
      derivedLimits?.weeklyCostLimit ??
      DEFAULT_LIMITS_WEEKLY.costLimit,
    calibratedAt: derivedLimits?.calibratedAt ?? "",
    calibrationPct: derivedLimits?.calibrationPct ?? 0,
    promoActive: derivedLimits?.promoActive ?? false,
  };
}

export function buildCalibratedBaseDerivedLimits(
  solvedLimits: Record<CalibrationScope, SolvedLimits>,
  fallback: DerivedLimits
): DerivedLimits {
  const fiveH = solvedLimits["5h"];
  const weekly = solvedLimits["weekly-all"];

  return {
    outputLimit:
      fiveH.methods.length > 0 && fiveH.best.confidence > 0 && fiveH.best.outputLimit > 0
        ? fiveH.best.outputLimit
        : fallback.outputLimit,
    inputOutputLimit:
      fiveH.methods.length > 0 && fiveH.best.confidence > 0 && fiveH.best.inputOutputLimit > 0
        ? fiveH.best.inputOutputLimit
        : fallback.inputOutputLimit,
    totalLimit:
      fiveH.methods.length > 0 && fiveH.best.confidence > 0 && fiveH.best.totalLimit > 0
        ? fiveH.best.totalLimit
        : fallback.totalLimit,
    costLimit:
      fiveH.methods.length > 0 && fiveH.best.confidence > 0 && fiveH.best.costLimit > 0
        ? fiveH.best.costLimit
        : fallback.costLimit,
    weeklyOutputLimit:
      weekly.methods.length > 0 && weekly.best.confidence > 0 && weekly.best.outputLimit > 0
        ? weekly.best.outputLimit
        : fallback.weeklyOutputLimit,
    weeklyInputOutputLimit:
      weekly.methods.length > 0 && weekly.best.confidence > 0 && weekly.best.inputOutputLimit > 0
        ? weekly.best.inputOutputLimit
        : fallback.weeklyInputOutputLimit,
    weeklyTotalLimit:
      weekly.methods.length > 0 && weekly.best.confidence > 0 && weekly.best.totalLimit > 0
        ? weekly.best.totalLimit
        : fallback.weeklyTotalLimit,
    weeklyCostLimit:
      weekly.methods.length > 0 && weekly.best.confidence > 0 && weekly.best.costLimit > 0
        ? weekly.best.costLimit
        : fallback.weeklyCostLimit,
    calibratedAt:
      fiveH.methods.length > 0 || weekly.methods.length > 0
        ? new Date().toISOString()
        : fallback.calibratedAt,
    calibrationPct: fallback.calibrationPct,
    promoActive: fallback.promoActive,
  };
}
