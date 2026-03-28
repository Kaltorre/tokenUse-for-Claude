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

const WINDOW_DURATION_MS = 5 * 60 * 60 * 1000; // 5 hours

// Off-peak promo: March 13–28, 2026
// Off-peak = outside 8 AM – 2 PM ET on weekdays
const PROMO_START = new Date("2026-03-13T00:00:00-04:00"); // ET
const PROMO_END = new Date("2026-03-29T03:59:00-04:00");   // end of March 28 ET
const PEAK_HOUR_START = 8;  // 8 AM ET
const PEAK_HOUR_END = 14;   // 2 PM ET

function totalTokens(e: UsageEntry): number {
  return (
    e.usage.input_tokens +
    e.usage.output_tokens +
    e.usage.cache_creation_input_tokens +
    e.usage.cache_read_input_tokens
  );
}

/** Find the nth occurrence of a day-of-week in a month (1-indexed day) */
function nthDayOfMonth(year: number, month: number, dayOfWeek: number, n: number): number {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((dayOfWeek - first + 7) % 7) + (n - 1) * 7;
}

/** Get ET offset in ms using DST rules (fast arithmetic, no Intl) */
function getETOffsetMs(date: Date): number {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();

  // Apr–Oct: always EDT (UTC-4)
  if (month >= 3 && month <= 9) return -4 * 3600000;
  // Dec–Feb: always EST (UTC-5)
  if (month === 11 || month <= 1) return -5 * 3600000;
  // March: DST starts 2nd Sunday at 2 AM EST = 7 AM UTC
  if (month === 2) {
    const dstStart = Date.UTC(year, 2, nthDayOfMonth(year, 2, 0, 2), 7);
    return date.getTime() >= dstStart ? -4 * 3600000 : -5 * 3600000;
  }
  // November: DST ends 1st Sunday at 2 AM EDT = 6 AM UTC
  const dstEnd = Date.UTC(year, 10, nthDayOfMonth(year, 10, 0, 1), 6);
  return date.getTime() < dstEnd ? -4 * 3600000 : -5 * 3600000;
}

/** Convert UTC Date to Eastern Time hour (0-23) and day of week (0=Sun) */
function toET(date: Date): { hour: number; dayOfWeek: number; isWeekday: boolean } {
  const etMs = date.getTime() + getETOffsetMs(date);
  const et = new Date(etMs);
  const day = et.getUTCDay();
  return {
    hour: et.getUTCHours(),
    dayOfWeek: day,
    isWeekday: day >= 1 && day <= 5,
  };
}

function matchesPromoSchedule(date: Date, schedule: PromoPeriod["schedule"]): boolean {
  if (schedule.type === "all-day-all-week") return true;

  const et = toET(date);

  if (schedule.type === "daily-hours") {
    return et.hour >= schedule.hourFrom && et.hour < schedule.hourTo;
  }

  if (!schedule.days.includes(et.dayOfWeek)) return false;
  if (schedule.hourFrom != null && schedule.hourTo != null) {
    const inRange = et.hour >= schedule.hourFrom && et.hour < schedule.hourTo;
    return schedule.excludeHours ? !inRange : inRange;
  }
  return true;
}

function getEntryPromoMultiplier(timestamp: string, promos: PromoPeriod[]): number {
  if (promos.length === 0) {
    return isOffPeak(new Date(timestamp)) ? 2 : 1;
  }

  const date = new Date(timestamp);
  const tMs = date.getTime();
  let maxMultiplier = 1;

  for (const promo of promos) {
    const from = new Date(promo.dateFrom).getTime();
    const to = new Date(promo.dateTo).getTime();
    if (tMs < from || tMs > to) continue;
    if (matchesPromoSchedule(date, promo.schedule)) {
      maxMultiplier = Math.max(maxMultiplier, promo.multiplier);
    }
  }

  return maxMultiplier;
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

/** Check if a timestamp falls in the off-peak promo period */
export function isOffPeak(date: Date): boolean {
  if (date < PROMO_START || date > PROMO_END) return false;
  const et = toET(date);
  if (!et.isWeekday) return true; // weekends are always off-peak
  return et.hour < PEAK_HOUR_START || et.hour >= PEAK_HOUR_END;
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
function classifyPeakStatus(entries: UsageEntry[]): PeakStatus {
  if (entries.length === 0) return "off-peak";

  let hasOffPeak = false;
  let hasPeak = false;

  for (const e of entries) {
    const d = new Date(e.timestamp);
    if (d < PROMO_START || d > PROMO_END) {
      // Outside promo period — no peak/off-peak distinction
      return "off-peak";
    }
    if (isOffPeak(d)) {
      hasOffPeak = true;
    } else {
      hasPeak = true;
    }
    if (hasOffPeak && hasPeak) return "mixed";
  }

  return hasOffPeak ? "off-peak" : "peak";
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
        windows.push(buildWindow(windowId++, windowStart, windowEnd, windowEntries));
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
    windows.push(buildWindow(windowId, windowStart, windowEnd, windowEntries));
  }

  return windows;
}

function buildWindow(
  id: number,
  start: Date,
  end: Date,
  entries: UsageEntry[]
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

  const peakStatus = classifyPeakStatus(entries);

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
    const offPeakEntries = entries.filter(e => isOffPeak(new Date(e.timestamp)));
    const peakEntries = entries.filter(e => !isOffPeak(new Date(e.timestamp)));
    peakSplit = { peak: sumGroup(peakEntries), offPeak: sumGroup(offPeakEntries) };
  }

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
function findWeekAnchor(
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
      (e) => getEntryPromoMultiplier(e.timestamp, promos) > 1
    );
    const standardEntries =
      bonusEntries.length === 0
        ? weekEntries
        : weekEntries.filter(
            (e) => getEntryPromoMultiplier(e.timestamp, promos) <= 1
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
  promos: PromoPeriod[] = []
): LimitsData {
  const windows = buildFiveHourWindows(entries, promos);
  const currentWindow = windows.find((w) => w.status === "active") || null;

  const { all: weeklyAll, sonnet: weeklySonnet } = buildWeeklyBuckets(entries, weeklyConfig, promos);

  const now = new Date();
  const currentWeekAll = weeklyAll.find((w) => {
    return now >= new Date(w.weekStart) && now < new Date(w.weekEnd);
  }) || null;
  const currentWeekSonnet = weeklySonnet.find((w) => {
    return now >= new Date(w.weekStart) && now < new Date(w.weekEnd);
  }) || null;

  return {
    windows,
    currentWindow,
    weeklyAll,
    weeklySonnet,
    currentWeekAll,
    currentWeekSonnet,
  };
}
