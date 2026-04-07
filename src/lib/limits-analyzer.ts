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
  return {
    inputTokens: group.reduce((s, e) => s + e.usage.input_tokens, 0),
    outputTokens: group.reduce((s, e) => s + e.usage.output_tokens, 0),
    cacheCreationTokens: group.reduce((s, e) => s + e.usage.cache_creation_input_tokens, 0),
    cacheReadTokens: group.reduce((s, e) => s + e.usage.cache_read_input_tokens, 0),
    totalTokens: group.reduce((s, e) => s + totalTokens(e), 0),
    totalCost: group.reduce((s, e) => s + e.cost, 0),
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

/** Determine peak status for a window based on its entries */
function classifyPeakStatus(entries: UsageEntry[], promos: PromoPeriod[]): PeakStatus {
  if (entries.length === 0) return "off-peak";

  let hasBonus = false;
  let hasStandard = false;
  let hasPromoContext = false;

  for (const e of entries) {
    const d = new Date(e.timestamp);
    const multiplier = getEntryPromoMultiplier(e.timestamp, promos);
    if (multiplier !== 1) {
      hasBonus = true;
      hasPromoContext = true;
    } else {
      hasStandard = true;
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
    if (hasBonus && hasStandard) return "mixed";
  }

  if (hasBonus) return "off-peak";
  return hasPromoContext ? "peak" : "off-peak";
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

  const sessionIds = [...new Set(entries.map((e) => e.sessionId))];
  const models: FiveHourWindow["models"] = {};
  for (const e of entries) {
    const name = getModelDisplayName(e.model);
    const m = models[name] ?? {
      messageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      totalCost: 0,
    };
    m.messageCount += 1;
    m.inputTokens += e.usage.input_tokens;
    m.outputTokens += e.usage.output_tokens;
    m.cacheCreationTokens += e.usage.cache_creation_input_tokens;
    m.cacheReadTokens += e.usage.cache_read_input_tokens;
    m.totalTokens += totalTokens(e);
    m.totalCost += e.cost;
    models[name] = m;
  }

  const peakStatus = classifyPeakStatus(entries, promos);

  let peakSplit: FiveHourWindow["peakSplit"] = undefined;
  if (peakStatus === "mixed") {
    const sumGroup = (group: UsageEntry[]): PeakSplitTokens => ({
      inputTokens: group.reduce((s, e) => s + e.usage.input_tokens, 0),
      outputTokens: group.reduce((s, e) => s + e.usage.output_tokens, 0),
      cacheCreationTokens: group.reduce((s, e) => s + e.usage.cache_creation_input_tokens, 0),
      cacheReadTokens: group.reduce((s, e) => s + e.usage.cache_read_input_tokens, 0),
      totalTokens: group.reduce((s, e) => s + totalTokens(e), 0),
      totalCost: group.reduce((s, e) => s + e.cost, 0),
      messageCount: group.length,
    });
    const offPeakEntries = entries.filter((e) => getEntryPromoMultiplier(e.timestamp, promos) !== 1);
    const peakEntries = entries.filter((e) => getEntryPromoMultiplier(e.timestamp, promos) === 1);
    peakSplit = { peak: sumGroup(peakEntries), offPeak: sumGroup(offPeakEntries) };
  }

  const normalized = sumNormalizedUsage(entries, promos);

  return {
    id,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    lastActivityTime: lastEntry.timestamp,
    status: isActive ? "active" : "expired",
    peakStatus,
    peakSplit,
    inputTokens: entries.reduce((s, e) => s + e.usage.input_tokens, 0),
    outputTokens: entries.reduce((s, e) => s + e.usage.output_tokens, 0),
    cacheCreationTokens: entries.reduce((s, e) => s + e.usage.cache_creation_input_tokens, 0),
    cacheReadTokens: entries.reduce((s, e) => s + e.usage.cache_read_input_tokens, 0),
    totalTokens: entries.reduce((s, e) => s + totalTokens(e), 0),
    totalCost: entries.reduce((s, e) => s + e.cost, 0),
    ...normalized,
    messageCount: entries.length,
    sessionIds,
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
