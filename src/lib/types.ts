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
  entries: UsageEntry[];
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
  totalCost: number;
  sessionCount: number;
  messageCount: number;
  lastUsed: string;
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

export interface FiveHourWindow {
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

export interface WeeklyBucket {
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

export type Bottleneck = "output" | "inout" | "total";

export interface DerivedLimits {
  /** Base limits (without promo multiplier) */
  outputLimit: number;       // e.g. 1.4M
  inputOutputLimit: number;  // e.g. 1.5M
  totalLimit: number;        // e.g. 408.5M
  /** Separate weekly limits (if calibrated) */
  weeklyOutputLimit: number | null;
  weeklyInputOutputLimit: number | null;
  weeklyTotalLimit: number | null;
  /** Calibration metadata */
  calibratedAt: string;      // ISO timestamp
  calibrationPct: number;    // % that was entered
  promoActive: boolean;      // was 2x promo active during calibration
}

export interface Utilization {
  outputPct: number;
  inoutPct: number;
  totalPct: number;
  effectivePct: number;
  bottleneck: Bottleneck;
}

// --- Calibration System ---

export type CalibrationScope = "5h" | "weekly-all" | "weekly-sonnet";

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
  multiplier: number; // max off-peak multiplier, e.g. 2.0 for 2x
}

export interface PromoConfig {
  periods: PromoPeriod[];
}

export const PLAN_TIERS: Record<PlanTier, {
  label: string;
  shortLabel: string;
  color: string;
  multiplier: number;  // relative to Max 20 = 1.0
  monthlyPrice: number;
}> = {
  max20: { label: "Max $200", shortLabel: "M20", color: "var(--accent-purple)", multiplier: 1.0, monthlyPrice: 200 },
  max5:  { label: "Max $100",  shortLabel: "M5",  color: "var(--accent-blue)",   multiplier: 0.25, monthlyPrice: 100 },
  pro:   { label: "Pro",     shortLabel: "Pro", color: "var(--accent-green)",  multiplier: 0.05, monthlyPrice: 20 },
  team:  { label: "Team",    shortLabel: "Tm",  color: "var(--accent-cyan)",   multiplier: 0.15, monthlyPrice: 30 },
  free:  { label: "Free",    shortLabel: "F",   color: "var(--text-muted)",    multiplier: 0.01, monthlyPrice: 0 },
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
