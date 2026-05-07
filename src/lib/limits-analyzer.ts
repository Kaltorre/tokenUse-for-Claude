import {
  UsageEntry,
  FiveHourWindow,
  PeakSplitTokens,
  WeeklyBucket,
  WeeklyResetConfig,
  LimitsData,
  PeakStatus,
  PromoPeriod,
} from "./types";
import { getModelDisplayName } from "./pricing";
import { getWarsawTimeParts, matchesPromoScheduleInPoland } from "./promo-time";

const WINDOW_DURATION_MS = 5 * 60 * 60 * 1000; // 5 hours

// Off-peak promo: March 13–28, 2026
// Off-peak = outside 13:00 – 19:00 Poland time on weekdays
const PROMO_START = new Date("2026-03-13T00:00:00+01:00");
const PROMO_END = new Date("2026-03-28T23:59:00+01:00");
const PEAK_HOUR_START = 13;
const PEAK_HOUR_END = 19;

function totalTokens(e: UsageEntry): number {
  return (
    e.usage.input_tokens +
    e.usage.output_tokens +
    e.usage.cache_creation_input_tokens +
    e.usage.cache_read_input_tokens
  );
}

function matchesPromoSchedule(date: Date, schedule: PromoPeriod["schedule"]): boolean {
  return matchesPromoScheduleInPoland(date, schedule);
}

function getEntryPromoMultiplier(timestamp: string, promos: PromoPeriod[]): number {
  if (promos.length === 0) {
    return isOffPeak(new Date(timestamp)) ? 2 : 1;
  }

  const date = new Date(timestamp);
  const tMs = date.getTime();
  let result = 1;

  for (const promo of promos) {
    const from = new Date(promo.dateFrom).getTime();
    const to = new Date(promo.dateTo).getTime();
    if (tMs < from || tMs > to) continue;
    if (matchesPromoSchedule(date, promo.schedule)) {
      result *= promo.multiplier;
    }
  }

  return result;
}

function sumGroup(group: UsageEntry[]): PeakSplitTokens {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let totalTok = 0;
  let totalCost = 0;
  for (const e of group) {
    inputTokens += e.usage.input_tokens;
    outputTokens += e.usage.output_tokens;
    cacheCreationTokens += e.usage.cache_creation_input_tokens;
    cacheReadTokens += e.usage.cache_read_input_tokens;
    totalTok += totalTokens(e);
    totalCost += e.cost;
  }
  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: totalTok,
    totalCost,
    messageCount: group.length,
  };
}

function sumNormalizedUsage(
  group: UsageEntry[],
  promos: PromoPeriod[]
): {
  normalizedInputTokens: number;
  normalizedOutputTokens: number;
  normalizedCacheCreationTokens: number;
  normalizedCacheReadTokens: number;
  normalizedTotalTokens: number;
  normalizedCost: number;
} {
  return group.reduce(
    (acc, entry) => {
      const multiplier = getEntryPromoMultiplier(entry.timestamp, promos) || 1;
      acc.normalizedInputTokens += entry.usage.input_tokens / multiplier;
      acc.normalizedOutputTokens += entry.usage.output_tokens / multiplier;
      acc.normalizedCacheCreationTokens +=
        entry.usage.cache_creation_input_tokens / multiplier;
      acc.normalizedCacheReadTokens +=
        entry.usage.cache_read_input_tokens / multiplier;
      acc.normalizedTotalTokens += totalTokens(entry) / multiplier;
      acc.normalizedCost += entry.cost / multiplier;
      return acc;
    },
    {
      normalizedInputTokens: 0,
      normalizedOutputTokens: 0,
      normalizedCacheCreationTokens: 0,
      normalizedCacheReadTokens: 0,
      normalizedTotalTokens: 0,
      normalizedCost: 0,
    }
  );
}

/** Check if a timestamp falls in the off-peak promo period */
export function isOffPeak(date: Date): boolean {
  if (date < PROMO_START || date > PROMO_END) return false;
  const local = getWarsawTimeParts(date);
  if (!local.isWeekday) return true; // weekends are always off-peak
  return local.hour < PEAK_HOUR_START || local.hour >= PEAK_HOUR_END;
}

/** Compute precise promo multiplier from peak-split token data.
 *  off-peak tokens get 2x, peak tokens get 1x → weighted average */
export function computeWeightedPromoMultiplier(
  peakSplit: NonNullable<FiveHourWindow["peakSplit"]>
): number {
  const totalAll = peakSplit.peak.totalTokens + peakSplit.offPeak.totalTokens;
  if (totalAll === 0) return 1.5; // fallback if no tokens yet
  const offPeakFraction = peakSplit.offPeak.totalTokens / totalAll;
  return Math.round((1 + offPeakFraction) * 100) / 100; // 1x + offPeakFrac * 1x
}

function isSonnetModel(model: string): boolean {
  return model.toLowerCase().includes("sonnet");
}

export function buildFiveHourWindows(entries: UsageEntry[], promos: PromoPeriod[] = []): FiveHourWindow[] {
  if (entries.length === 0) return [];

  const sorted = [...entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const windows: FiveHourWindow[] = [];
  let windowId = 1;

  // Snap window start to the full hour (Claude counts sessions from full hours)
  const firstTime = new Date(sorted[0].timestamp);
  let windowStart = new Date(firstTime);
  windowStart.setMinutes(0, 0, 0); // snap to :00
  let windowEnd = new Date(windowStart.getTime() + WINDOW_DURATION_MS);
  let windowEntries: UsageEntry[] = [];

  for (const entry of sorted) {
    const entryTime = new Date(entry.timestamp);

    if (entryTime >= windowEnd) {
      // Finalize current window
      if (windowEntries.length > 0) {
        windows.push(buildWindow(windowId++, windowStart, windowEnd, windowEntries, promos));
      }
      // Start new window — snap to full hour
      windowStart = new Date(entryTime);
      windowStart.setMinutes(0, 0, 0);
      windowEnd = new Date(windowStart.getTime() + WINDOW_DURATION_MS);
      windowEntries = [];
    }

    windowEntries.push(entry);
  }

  // Finalize last window
  if (windowEntries.length > 0) {
    windows.push(buildWindow(windowId, windowStart, windowEnd, windowEntries, promos));
  }

  return windows;
}

function buildWindow(
  id: number,
  start: Date,
  end: Date,
  entries: UsageEntry[],
  promos: PromoPeriod[]
): FiveHourWindow {
  const now = new Date();
  const isActive = now < end;
  const lastEntry = entries[entries.length - 1];

  const sessionIdSet = new Set<string>();
  const models: FiveHourWindow["models"] = {};

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let totalTok = 0;
  let totalCost = 0;

  let normalizedInputTokens = 0;
  let normalizedOutputTokens = 0;
  let normalizedCacheCreationTokens = 0;
  let normalizedCacheReadTokens = 0;
  let normalizedTotalTokens = 0;
  let normalizedCost = 0;

  let hasBonus = false;
  let hasStandard = false;
  let hasPromoContext = false;

  let peakInput = 0;
  let peakOutput = 0;
  let peakCacheCreation = 0;
  let peakCacheRead = 0;
  let peakTotal = 0;
  let peakCost = 0;
  let peakMessages = 0;

  let offInput = 0;
  let offOutput = 0;
  let offCacheCreation = 0;
  let offCacheRead = 0;
  let offTotal = 0;
  let offCost = 0;
  let offMessages = 0;

  for (const e of entries) {
    sessionIdSet.add(e.sessionId);

    const tt = totalTokens(e);
    inputTokens += e.usage.input_tokens;
    outputTokens += e.usage.output_tokens;
    cacheCreationTokens += e.usage.cache_creation_input_tokens;
    cacheReadTokens += e.usage.cache_read_input_tokens;
    totalTok += tt;
    totalCost += e.cost;

    const multiplier = getEntryPromoMultiplier(e.timestamp, promos) || 1;
    normalizedInputTokens += e.usage.input_tokens / multiplier;
    normalizedOutputTokens += e.usage.output_tokens / multiplier;
    normalizedCacheCreationTokens += e.usage.cache_creation_input_tokens / multiplier;
    normalizedCacheReadTokens += e.usage.cache_read_input_tokens / multiplier;
    normalizedTotalTokens += tt / multiplier;
    normalizedCost += e.cost / multiplier;

    if (multiplier !== 1) {
      hasBonus = true;
      hasPromoContext = true;
      offInput += e.usage.input_tokens;
      offOutput += e.usage.output_tokens;
      offCacheCreation += e.usage.cache_creation_input_tokens;
      offCacheRead += e.usage.cache_read_input_tokens;
      offTotal += tt;
      offCost += e.cost;
      offMessages += 1;
    } else {
      hasStandard = true;
      peakInput += e.usage.input_tokens;
      peakOutput += e.usage.output_tokens;
      peakCacheCreation += e.usage.cache_creation_input_tokens;
      peakCacheRead += e.usage.cache_read_input_tokens;
      peakTotal += tt;
      peakCost += e.cost;
      peakMessages += 1;
      if (!hasPromoContext) {
        const d = new Date(e.timestamp);
        const inLegacyPromoWindow =
          promos.length === 0 && d >= PROMO_START && d <= PROMO_END;
        const inConfiguredPromoWindow =
          promos.length > 0 &&
          promos.some((promo) => {
            const from = new Date(promo.dateFrom).getTime();
            const to = new Date(promo.dateTo).getTime();
            const time = d.getTime();
            return time >= from && time <= to;
          });
        if (inLegacyPromoWindow || inConfiguredPromoWindow) {
          hasPromoContext = true;
        }
      }
    }

    const name = getModelDisplayName(e.model);
    let m = models[name];
    if (!m) {
      m = {
        messageCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        totalCost: 0,
      };
      models[name] = m;
    }
    m.messageCount += 1;
    m.inputTokens += e.usage.input_tokens;
    m.outputTokens += e.usage.output_tokens;
    m.cacheCreationTokens += e.usage.cache_creation_input_tokens;
    m.cacheReadTokens += e.usage.cache_read_input_tokens;
    m.totalTokens += tt;
    m.totalCost += e.cost;
  }

  const peakStatus: PeakStatus = entries.length === 0
    ? "off-peak"
    : hasBonus && hasStandard
      ? "mixed"
      : hasBonus
        ? "off-peak"
        : hasPromoContext
          ? "peak"
          : "off-peak";

  const peakSplit: FiveHourWindow["peakSplit"] = peakStatus === "mixed"
    ? {
        peak: {
          inputTokens: peakInput,
          outputTokens: peakOutput,
          cacheCreationTokens: peakCacheCreation,
          cacheReadTokens: peakCacheRead,
          totalTokens: peakTotal,
          totalCost: peakCost,
          messageCount: peakMessages,
        },
        offPeak: {
          inputTokens: offInput,
          outputTokens: offOutput,
          cacheCreationTokens: offCacheCreation,
          cacheReadTokens: offCacheRead,
          totalTokens: offTotal,
          totalCost: offCost,
          messageCount: offMessages,
        },
      }
    : undefined;

  return {
    id,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    lastActivityTime: lastEntry.timestamp,
    status: isActive ? "active" : "expired",
    peakStatus,
    peakSplit,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: totalTok,
    totalCost,
    normalizedInputTokens,
    normalizedOutputTokens,
    normalizedCacheCreationTokens,
    normalizedCacheReadTokens,
    normalizedTotalTokens,
    normalizedCost,
    messageCount: entries.length,
    sessionIds: [...sessionIdSet],
    models,
    timeRemainingMs: isActive ? end.getTime() - now.getTime() : 0,
  };
}

/** Add or subtract N weeks using local calendar dates (DST-safe) */
function addLocalWeeks(date: Date, weeks: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + weeks * 7);
  return d;
}

/** Find the weekly reset anchor (most recent reset point before `now`) */
export function findWeekAnchor(
  now: Date,
  config: { day: number; hour: number; minute: number }
): Date {
  // Start from current week's reset day/time (local time)
  const anchor = new Date(now);
  anchor.setHours(config.hour, config.minute, 0, 0);

  // Set to the right day of week (local)
  const diff = anchor.getDay() - config.day;
  anchor.setDate(anchor.getDate() - diff);

  // If anchor is in the future, go back one week
  if (anchor > now) {
    anchor.setDate(anchor.getDate() - 7);
  }

  return anchor;
}

export function buildWeeklyBuckets(
  entries: UsageEntry[],
  config: WeeklyResetConfig,
  promos: PromoPeriod[] = []
): { all: WeeklyBucket[]; sonnet: WeeklyBucket[] } {
  const now = new Date();

  const allBuckets = buildBucketsForFilter(entries, config.allModels, "all", now, promos);
  const sonnetEntries = entries.filter((e) => isSonnetModel(e.model));
  const sonnetBuckets = buildBucketsForFilter(sonnetEntries, config.sonnetOnly, "sonnet", now, promos);

  return { all: allBuckets, sonnet: sonnetBuckets };
}

function buildBucketsForFilter(
  entries: UsageEntry[],
  resetConfig: { day: number; hour: number; minute: number },
  modelFilter: "all" | "sonnet",
  now: Date,
  promos: PromoPeriod[]
): WeeklyBucket[] {
  if (entries.length === 0) return [];

  const sorted = [...entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Find the current week's anchor
  const currentAnchor = findWeekAnchor(now, resetConfig);

  // Find the earliest entry and build back to it
  const earliest = new Date(sorted[0].timestamp);
  const anchors: Date[] = [];
  let anchor = new Date(currentAnchor);

  // Go back enough weeks to cover all data
  while (anchor.getTime() > earliest.getTime() - 7 * 24 * 60 * 60 * 1000) {
    anchors.unshift(new Date(anchor));
    anchor = addLocalWeeks(anchor, -1);
  }
  // Make sure we have at least one anchor before the earliest entry
  if (anchors.length === 0 || anchors[0] > earliest) {
    anchors.unshift(new Date(anchor));
  }

  const buckets: WeeklyBucket[] = [];

  for (let i = 0; i < anchors.length; i++) {
    const weekStart = anchors[i];
    const weekEnd = addLocalWeeks(weekStart, 1);

    const weekEntries = sorted.filter((e) => {
      const t = new Date(e.timestamp);
      return t >= weekStart && t < weekEnd;
    });

    if (weekEntries.length === 0) continue;

    const isCurrentWeek = now >= weekStart && now < weekEnd;
    const bonusEntries = weekEntries.filter(
      (e) => getEntryPromoMultiplier(e.timestamp, promos) !== 1
    );
    const standardEntries =
      bonusEntries.length === 0
        ? weekEntries
        : weekEntries.filter(
            (e) => getEntryPromoMultiplier(e.timestamp, promos) === 1
          );

    const peakStatus: PeakStatus =
      bonusEntries.length === 0
        ? "peak"
        : standardEntries.length === 0
        ? "off-peak"
        : "mixed";

    const peakSplit =
      bonusEntries.length > 0
        ? {
            peak: sumGroup(standardEntries),
            offPeak: sumGroup(bonusEntries),
          }
        : undefined;
    const normalized = sumNormalizedUsage(weekEntries, promos);

    buckets.push({
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      modelFilter,
      peakStatus,
      peakSplit,
      inputTokens: weekEntries.reduce((s, e) => s + e.usage.input_tokens, 0),
      outputTokens: weekEntries.reduce((s, e) => s + e.usage.output_tokens, 0),
      cacheCreationTokens: weekEntries.reduce((s, e) => s + e.usage.cache_creation_input_tokens, 0),
      cacheReadTokens: weekEntries.reduce((s, e) => s + e.usage.cache_read_input_tokens, 0),
      totalTokens: weekEntries.reduce((s, e) => s + totalTokens(e), 0),
      totalCost: weekEntries.reduce((s, e) => s + e.cost, 0),
      ...normalized,
      windowCount: 0, // will be set from windows if needed
      messageCount: weekEntries.length,
      timeRemainingMs: isCurrentWeek ? weekEnd.getTime() - now.getTime() : 0,
    });
  }

  return buckets;
}

/** Default weekly reset config based on user's Claude UI data */
export const DEFAULT_WEEKLY_CONFIG: WeeklyResetConfig = {
  allModels: { day: 0, hour: 9, minute: 0 },   // Sunday 9:00 AM (user's local → stored as-is)
  sonnetOnly: { day: 1, hour: 1, minute: 0 },   // Monday 1:00 AM
};

export function buildLimitsData(
  entries: UsageEntry[],
  weeklyConfig: WeeklyResetConfig = DEFAULT_WEEKLY_CONFIG,
  promos: PromoPeriod[] = [],
  onProgress?: (message: string, current: number, total: number) => void
): LimitsData {
  const totalSteps = 3;
  const windows = buildFiveHourWindows(entries, promos);
  onProgress?.("Built 5h windows", 1, totalSteps);
  const currentWindow = windows.find((w) => w.status === "active") || null;

  const { all: weeklyAll, sonnet: weeklySonnet } = buildWeeklyBuckets(entries, weeklyConfig, promos);
  onProgress?.("Built weekly buckets", 2, totalSteps);

  const now = new Date();
  const currentWeekAll = weeklyAll.find((w) => {
    return now >= new Date(w.weekStart) && now < new Date(w.weekEnd);
  }) || null;
  const currentWeekSonnet = weeklySonnet.find((w) => {
    return now >= new Date(w.weekStart) && now < new Date(w.weekEnd);
  }) || null;
  onProgress?.("Resolved active limit windows", 3, totalSteps);

  return {
    windows,
    currentWindow,
    weeklyAll,
    weeklySonnet,
    currentWeekAll,
    currentWeekSonnet,
  };
}
