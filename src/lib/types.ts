export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface UsageEntry {
  timestamp: string;
  sessionId: string;
  model: string;
  usage: TokenUsage;
  cost: number;
  project: string;
  cwd: string;
  type: string;
  agentType?: string;  // from .meta.json — "general-purpose", "Explore", "writer", etc.
}

export interface SessionStats {
  sessionId: string;
  project: string;
  cwd: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
  messageCount: number;
  models: Record<string, number>;
}

export interface DailyStats {
  date: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
  sessionCount: number;
  messageCount: number;
  models: Record<string, number>;
}

export interface ProjectStats {
  project: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
  sessionCount: number;
  messageCount: number;
  lastUsed: string;
  models: Record<string, ModelTokenBreakdown>;
}

export interface ModelStats {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  messageCount: number;
}

export interface ModelTokenBreakdown {
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
}

export interface OverviewStats {
  totalTokens: number;
  totalCost: number;
  totalSessions: number;
  totalMessages: number;
  avgTokensPerSession: number;
  avgCostPerDay: number;
  todayTokens: number;
  todayCost: number;
  todaySessions: number;
  thisWeekTokens: number;
  thisWeekCost: number;
  thisMonthTokens: number;
  thisMonthCost: number;
  topModel: string;
  topProject: string;
  peakDay: string;
  peakDayTokens: number;
}

// --- Limits / 5h Window types ---

export type WindowStatus = "active" | "expired";
export type PeakStatus = "peak" | "off-peak" | "mixed";

export interface PeakSplitTokens {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  messageCount: number;
}

export interface NormalizedUsageTotals {
  normalizedInputTokens: number;
  normalizedOutputTokens: number;
  normalizedCacheCreationTokens: number;
  normalizedCacheReadTokens: number;
  normalizedTotalTokens: number;
  normalizedCost: number;
}

export interface FiveHourWindow extends NormalizedUsageTotals {
  id: number;
  startTime: string;           // ISO 8601 UTC
  endTime: string;             // window_start + 5h (theoretical end)
  lastActivityTime: string;    // timestamp of last entry in window
  status: WindowStatus;
  peakStatus: PeakStatus;
  /** Token breakdown by peak/off-peak zone (present only for "mixed" windows during promo) */
  peakSplit?: {
    peak: PeakSplitTokens;
    offPeak: PeakSplitTokens;
  };
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  messageCount: number;
  sessionIds: string[];
  models: Record<string, ModelTokenBreakdown>;
  timeRemainingMs: number;     // 0 if expired
}

export interface WeeklyResetConfig {
  allModels: { day: number; hour: number; minute: number };   // day: 0=Sun..6=Sat
  sonnetOnly: { day: number; hour: number; minute: number };
}

export interface WeeklyBucket extends NormalizedUsageTotals {
  weekStart: string;           // ISO 8601 UTC
  weekEnd: string;
  modelFilter: "all" | "sonnet";
  /** Reuses the 5h shape: `peak` = standard 1x, `offPeak` = bonus-eligible promo usage */
  peakStatus?: PeakStatus;
  peakSplit?: {
    peak: PeakSplitTokens;
    offPeak: PeakSplitTokens;
  };
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  windowCount: number;
  messageCount: number;
  timeRemainingMs: number;     // 0 if past week
}

export interface LimitsData {
  windows: FiveHourWindow[];
  currentWindow: FiveHourWindow | null;
  weeklyAll: WeeklyBucket[];
  weeklySonnet: WeeklyBucket[];
  currentWeekAll: WeeklyBucket | null;
  currentWeekSonnet: WeeklyBucket | null;
}

// --- Derived Limits & Utilization ---

/**
 * Base limits for Pro plan (tier multiplier = 1x), peak.
 * Derived from Max $200 calibration (36 deltas, 353% 5h coverage) ÷ 20.
 *
 * Pro = 1x base, Max $100 = 5x, Max $200 = 20x (as advertised by Anthropic).
 */
const BASE_LIMITS_5H = {
  outputLimit:      81_500,        // 1.63M / 20
  inputOutputLimit: 94_500,        // 1.89M / 20
  totalLimit:       24_200_000,    // 484M / 20
  costLimit:        21.80,         // $436 / 20
} as const;

const BASE_LIMITS_WEEKLY = {
  outputLimit:      485_000,       // 9.7M / 20
  inputOutputLimit: 575_000,       // 11.5M / 20
  totalLimit:       140_000_000,   // 2.8B / 20
  costLimit:        125,           // $2500 / 20
} as const;

export interface PlanLimits {
  outputLimit: number;
  inputOutputLimit: number;
  totalLimit: number;
  costLimit: number;
}

/** Get default limits for a plan tier (scales from Max $200 base). */
export function getDefaultLimits(tier: PlanTier, window: "5h" | "weekly"): PlanLimits {
  const m = PLAN_TIERS[tier].multiplier;
  const base = window === "5h" ? BASE_LIMITS_5H : BASE_LIMITS_WEEKLY;
  return {
    outputLimit:      Math.round(base.outputLimit * m),
    inputOutputLimit: Math.round(base.inputOutputLimit * m),
    totalLimit:       Math.round(base.totalLimit * m),
    costLimit:        Math.round(base.costLimit * m * 100) / 100,
  };
}

/** Shortcut: Max $200 defaults (multiplier 1.0). */
export const DEFAULT_LIMITS_5H = BASE_LIMITS_5H;
export const DEFAULT_LIMITS_WEEKLY = BASE_LIMITS_WEEKLY;

export type Bottleneck = "output" | "inout" | "total" | "cost";

export interface DerivedLimits {
  /** Base limits (without promo multiplier) */
  outputLimit: number;       // 5h: ~1.63M (Max $200 peak)
  inputOutputLimit: number;  // 5h: ~1.89M
  totalLimit: number;        // 5h: ~484M
  costLimit: number;         // 5h: ~$436 (CV 0.20 — most stable)
  /** Separate weekly limits (if calibrated) */
  weeklyOutputLimit: number | null;
  weeklyInputOutputLimit: number | null;
  weeklyTotalLimit: number | null;
  weeklyCostLimit: number | null;
  /** Calibration metadata */
  calibratedAt: string;      // ISO timestamp
  calibrationPct: number;    // % that was entered
  promoActive: boolean;      // was 2x promo active during calibration
}

export interface Utilization {
  outputPct: number;
  inoutPct: number;
  totalPct: number;
  costPct: number;
  effectivePct: number;
  bottleneck: Bottleneck;
}

// --- Calibration System ---

export type CalibrationScope = "5h" | "weekly-all" | "weekly-sonnet";
export type LimitWindowType = "5h" | "weekly";

export type AnomalyTag =
  | 'data-entry-error'
  | 'unknown-promo'
  | 'genuine-limit-change';

export interface AnomalyFlag {
  status: 'normal' | 'flagged' | 'excluded';
  source?: 'auto' | 'reviewed';
  tag?: AnomalyTag;
  note?: string;
  detectedAt?: string; // ISO 8601
}

export interface CalibrationPoint {
  id: string;                    // unique ID
  timestamp: string;             // when the user observed the %
  reportedPct: number;           // Claude-reported %
  scope: CalibrationScope;       // what limit was being reported
  /** Token snapshot at the time of calibration */
  tokens: {
    output: number;
    input: number;
    cacheWrite: number;
    cacheRead: number;
    total: number;
  };
  /**
   * Same snapshot normalized to base 1x capacity.
   * Example: during 2x bonus, 200 raw tokens count as 100 normalized tokens.
   */
  normalizedTokens?: {
    output: number;
    input: number;
    cacheWrite: number;
    cacheRead: number;
    total: number;
    cost: number;
  };
  cost: number;                  // session/week cost at time of calibration
  /** Which 5h window or week this maps to */
  windowId: number | null;
  windowStart: string | null;
  /** Peak/promo context */
  peakStatus: PeakStatus;
  /**
   * Plan tier active when this point was captured. Used by the solver to
   * scale `cost` / tokens to the max20 baseline so a single solved limit
   * works for every plan via `calibratedPlanLimits` (which divides by 20).
   * Undefined = legacy point without recorded tier — treated as max20 to
   * preserve historical behavior.
   */
  planTier?: PlanTier;
  anomalyFlag?: AnomalyFlag;
  /** Per-model token/cost breakdown at snapshot time */
  modelBreakdown?: Record<string, ModelTokenBreakdown>;
  /** Per-agent-type token/cost breakdown (subagent analysis) */
  agentBreakdown?: Record<string, ModelTokenBreakdown>;
}

export type EstimationMethod = "direct" | "cost" | "weighted" | "ensemble";

export interface SolvedLimits {
  /** Per-method results */
  methods: {
    method: EstimationMethod;
    outputLimit: number;
    inputOutputLimit: number;
    totalLimit: number;
    costLimit: number;            // cost-based limit ($)
    confidence: number;           // 0-1
    dataPoints: number;
  }[];
  /** Best estimate (ensemble) */
  best: {
    outputLimit: number;
    inputOutputLimit: number;
    totalLimit: number;
    costLimit: number;
    confidence: number;
  };
  /** Token weights (if solved) — how much each token type "costs" toward the limit */
  weights: {
    output: number;               // normalized, output = 1.0
    input: number;
    cacheWrite: number;
    cacheRead: number;
  } | null;
  /** Scope these limits apply to */
  scope: CalibrationScope;
}

// --- Plan Tiers ---

export type PlanTier = "max20" | "max5" | "pro" | "team" | "free";

export interface PlanPeriod {
  id: string;
  tier: PlanTier;
  startDate: string;   // ISO 8601
  endDate: string | null; // null = current/ongoing
  displayName?: string;
  /** Optional hypothesis override relative to Pro = 1x. Defaults to PLAN_TIERS[tier].multiplier. */
  theoreticalMultiplier?: number;
  /** Optional per-window hypothesis override when 5h and weekly do not scale the same way. */
  theoreticalMultipliers?: Partial<Record<LimitWindowType, number>>;
  note?: string;
}

export interface PlanConfig {
  periods: PlanPeriod[];
}

// --- Promo Periods ---

export type PromoSchedule =
  | { type: "all-day-all-week" }
  | { type: "daily-hours"; hourFrom: number; hourTo: number }
  | { type: "weekdays"; days: number[]; hourFrom?: number; hourTo?: number; excludeHours?: boolean };

export interface PromoPeriod {
  id: string;
  name: string;
  dateFrom: string;   // ISO 8601
  dateTo: string;     // ISO 8601
  schedule: PromoSchedule;
  multiplier: number; // capacity multiplier: >1 = bonus (e.g. 2x), <1 = reduced (e.g. 0.5x)
}

export interface PromoConfig {
  periods: PromoPeriod[];
}

export const PLAN_TIERS: Record<PlanTier, {
  label: string;
  shortLabel: string;
  color: string;
  multiplier: number;  // relative to Pro = 1x (Max $100 = 5x, Max $200 = 20x)
  monthlyPrice: number;
}> = {
  max20: { label: "Max $200", shortLabel: "M20", color: "var(--accent-purple)", multiplier: 20, monthlyPrice: 200 },
  max5:  { label: "Max $100", shortLabel: "M5",  color: "var(--accent-blue)",   multiplier: 5, monthlyPrice: 100 },
  pro:   { label: "Pro",      shortLabel: "Pro", color: "var(--accent-green)",  multiplier: 1, monthlyPrice: 20 },
  team:  { label: "Team",     shortLabel: "Tm",  color: "var(--accent-cyan)",   multiplier: 3, monthlyPrice: 30 },
  free:  { label: "Free",     shortLabel: "F",   color: "var(--text-muted)",    multiplier: 0, monthlyPrice: 0 },  // no Claude Code access
};

// --- Session Overrides ---

export interface SessionOverrideEntry {
  start: string;   // ISO 8601 UTC
  end: string;     // ISO 8601 UTC
}

export interface SessionOverrides {
  weekly: Record<string, SessionOverrideEntry>;   // key: "YYYY-WNN"
  "5h": Record<string, SessionOverrideEntry>;     // key: detected_start ISO timestamp
}

export interface UsageData {
  overview: OverviewStats;
  daily: DailyStats[];
  sessions: SessionStats[];
  projects: ProjectStats[];
  models: ModelStats[];
  hourly: { hour: number; tokens: number; cost: number; messages: number }[];
  limits: LimitsData;
}

// --- Data Sources ---

export interface DataSource {
  id: string;
  path: string;
  label: string;
  enabled: boolean;
}

export interface SourcesConfig {
  primaryEnabled: boolean;
  sources: DataSource[];
}

// --- Limit Overrides ---

export type LimitOverrideScope = "5h" | "weekly";

/** Per-tier per-window manual limit overrides. Null fields = use calibrated/default. */
export interface LimitOverrideEntry {
  costLimit?: number | null;
  outputLimit?: number | null;
  inputOutputLimit?: number | null;
  totalLimit?: number | null;
}

/** Key format: "{tier}:{scope}" e.g. "max20:5h", "pro:weekly" */
export type LimitOverridesMap = Record<string, LimitOverrideEntry>;

export interface LimitOverridesConfig {
  overrides: LimitOverridesMap;
}
