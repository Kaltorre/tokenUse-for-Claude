import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { CalibrationPoint, SessionOverrides, UsageEntry, FiveHourWindow, PromoPeriod, ModelTokenBreakdown } from "@/lib/types";
import { readAllUsageData } from "@/lib/reader";
import { getActivePromoMultiplier, isInPromoRange } from "@/lib/utilization";
import { buildFiveHourWindows, buildWeeklyBuckets, DEFAULT_WEEKLY_CONFIG } from "@/lib/limits-analyzer";
import { getModelDisplayName } from "@/lib/pricing";

const DATA_DIR = path.join(process.cwd(), "data");
const CAL_FILE = path.join(DATA_DIR, "calibrations.json");
const PROMOS_FILE = path.join(DATA_DIR, "promos.json");

function readPromos(): PromoPeriod[] {
  try {
    if (!fs.existsSync(PROMOS_FILE)) return [];
    const raw = fs.readFileSync(PROMOS_FILE, "utf-8");
    return (JSON.parse(raw) as { periods: PromoPeriod[] }).periods ?? [];
  } catch {
    return [];
  }
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

type CalibrationFile = {
  calibrations: CalibrationPoint[];
  session_overrides: SessionOverrides;
};

type CalibrationSnapshot =
  | NonNullable<ReturnType<typeof computeSnapshotAt>>
  | NonNullable<ReturnType<typeof computeWeeklySnapshotAt>>;

function emptyOverrides(): SessionOverrides {
  return { weekly: {}, "5h": {} };
}

/** Read calibrations.json — handles both old [] format and new { calibrations, session_overrides } format */
function readCalFile(): CalibrationFile {
  try {
    if (!fs.existsSync(CAL_FILE)) return { calibrations: [], session_overrides: emptyOverrides() };
    const raw = fs.readFileSync(CAL_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Old format: migrate to new format
      return { calibrations: parsed as CalibrationPoint[], session_overrides: emptyOverrides() };
    }
    const file = parsed as Partial<CalibrationFile>;
    return {
      calibrations: file.calibrations ?? [],
      session_overrides: file.session_overrides ?? emptyOverrides(),
    };
  } catch {
    return { calibrations: [], session_overrides: emptyOverrides() };
  }
}

function writeCalFile(file: CalibrationFile): void {
  ensureDir();
  fs.writeFileSync(CAL_FILE, JSON.stringify(file, null, 2), "utf-8");
}

function readCalibrations(): CalibrationPoint[] {
  return readCalFile().calibrations;
}

function writeCalibrations(points: CalibrationPoint[]): void {
  const file = readCalFile();
  file.calibrations = points;
  writeCalFile(file);
}

function entryPromoMultiplier(timestamp: string, promos: PromoPeriod[]): number {
  if (promos.length > 0) {
    return getActivePromoMultiplier(timestamp, promos);
  }
  return isInPromoRange(timestamp) ? 2 : 1;
}

function sumTokens(group: UsageEntry[]): NonNullable<FiveHourWindow["peakSplit"]>["peak"] {
  return {
    inputTokens: group.reduce((s, e) => s + e.usage.input_tokens, 0),
    outputTokens: group.reduce((s, e) => s + e.usage.output_tokens, 0),
    cacheCreationTokens: group.reduce((s, e) => s + e.usage.cache_creation_input_tokens, 0),
    cacheReadTokens: group.reduce((s, e) => s + e.usage.cache_read_input_tokens, 0),
    totalTokens: group.reduce(
      (s, e) =>
        s +
        e.usage.input_tokens +
        e.usage.output_tokens +
        e.usage.cache_creation_input_tokens +
        e.usage.cache_read_input_tokens,
      0
    ),
    totalCost: group.reduce((s, e) => s + e.cost, 0),
    messageCount: group.length,
  };
}

function sumNormalizedTokens(
  group: UsageEntry[],
  promos: PromoPeriod[]
): NonNullable<CalibrationPoint["normalizedTokens"]> {
  return group.reduce<NonNullable<CalibrationPoint["normalizedTokens"]>>(
    (acc, entry) => {
      const multiplier = entryPromoMultiplier(entry.timestamp, promos) || 1;
      acc.output += entry.usage.output_tokens / multiplier;
      acc.input += entry.usage.input_tokens / multiplier;
      acc.cacheWrite += entry.usage.cache_creation_input_tokens / multiplier;
      acc.cacheRead += entry.usage.cache_read_input_tokens / multiplier;
      acc.total +=
        (entry.usage.input_tokens +
          entry.usage.output_tokens +
          entry.usage.cache_creation_input_tokens +
          entry.usage.cache_read_input_tokens) /
        multiplier;
      acc.cost += entry.cost / multiplier;
      return acc;
    },
    { output: 0, input: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: 0 }
  );
}

function buildModelBreakdown(entries: UsageEntry[]): Record<string, ModelTokenBreakdown> {
  const result: Record<string, ModelTokenBreakdown> = {};
  for (const e of entries) {
    const name = getModelDisplayName(e.model);
    const m = result[name] ?? {
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
    m.totalTokens +=
      e.usage.input_tokens +
      e.usage.output_tokens +
      e.usage.cache_creation_input_tokens +
      e.usage.cache_read_input_tokens;
    m.totalCost += e.cost;
    result[name] = m;
  }
  return result;
}

function buildAgentBreakdown(entries: UsageEntry[]): Record<string, ModelTokenBreakdown> {
  const result: Record<string, ModelTokenBreakdown> = {};
  for (const e of entries) {
    const key = e.agentType ?? "main";
    const m = result[key] ?? {
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
    m.totalTokens +=
      e.usage.input_tokens +
      e.usage.output_tokens +
      e.usage.cache_creation_input_tokens +
      e.usage.cache_read_input_tokens;
    m.totalCost += e.cost;
    result[key] = m;
  }
  return result;
}

function buildSnapshotContext(
  relevant: UsageEntry[],
  promos: PromoPeriod[]
): {
  peakStatus: string;
  peakSplit?: FiveHourWindow["peakSplit"];
  normalizedTokens: NonNullable<CalibrationPoint["normalizedTokens"]>;
} {
  const bonusEntries = relevant.filter((e) => entryPromoMultiplier(e.timestamp, promos) > 1);
  const standardEntries =
    bonusEntries.length === 0
      ? relevant
      : relevant.filter((e) => entryPromoMultiplier(e.timestamp, promos) <= 1);

  const peakStatus =
    bonusEntries.length === 0
      ? "peak"
      : standardEntries.length === 0
      ? "off-peak"
      : "mixed";
  const peakSplit =
    bonusEntries.length > 0
      ? {
          peak: sumTokens(standardEntries),
          offPeak: sumTokens(bonusEntries),
        }
      : undefined;

  return {
    peakStatus,
    peakSplit,
    normalizedTokens: sumNormalizedTokens(relevant, promos),
  };
}

/**
 * Compute token snapshot at a specific time.
 * Sums all entries from the start of the matching 5h window up to `observedAt`.
 */
function computeSnapshotAt(observedAt: string, preloaded?: UsageEntry[]): {
  tokens: CalibrationPoint["tokens"];
  normalizedTokens: NonNullable<CalibrationPoint["normalizedTokens"]>;
  cost: number;
  windowId: number | null;
  windowStart: string | null;
  peakStatus: string;
  messageCount: number;
  peakSplit?: FiveHourWindow["peakSplit"];
  modelBreakdown: Record<string, ModelTokenBreakdown>;
  agentBreakdown: Record<string, ModelTokenBreakdown>;
} | null {
  const entries = preloaded ?? readAllUsageData();
  const promos = readPromos();
  const windows = buildFiveHourWindows(entries, promos);
  const obsTime = new Date(observedAt).getTime();

  // Find the window that contains this timestamp
  const win = windows.find((w) => {
    const start = new Date(w.startTime).getTime();
    const end = new Date(w.endTime).getTime();
    return obsTime >= start && obsTime <= end;
  });

  if (!win) {
    // No matching window — sum all entries up to this time in last 5h
    const fiveHoursBack = obsTime - 5 * 60 * 60 * 1000;
    const relevant = entries.filter((e) => {
      const t = new Date(e.timestamp).getTime();
      return t >= fiveHoursBack && t <= obsTime;
    });

    if (relevant.length === 0) return null;

    const context = buildSnapshotContext(relevant, promos);

    return {
      tokens: {
        output: relevant.reduce((s, e) => s + e.usage.output_tokens, 0),
        input: relevant.reduce((s, e) => s + e.usage.input_tokens, 0),
        cacheWrite: relevant.reduce((s, e) => s + e.usage.cache_creation_input_tokens, 0),
        cacheRead: relevant.reduce((s, e) => s + e.usage.cache_read_input_tokens, 0),
        total: relevant.reduce(
          (s, e) =>
            s +
            e.usage.input_tokens +
            e.usage.output_tokens +
            e.usage.cache_creation_input_tokens +
            e.usage.cache_read_input_tokens,
          0
        ),
      },
      normalizedTokens: context.normalizedTokens,
      cost: relevant.reduce((s, e) => s + e.cost, 0),
      windowId: null,
      windowStart: relevant[0].timestamp,
      peakStatus: context.peakStatus,
      messageCount: relevant.length,
      peakSplit: context.peakSplit,
      modelBreakdown: buildModelBreakdown(relevant),
      agentBreakdown: buildAgentBreakdown(relevant),
    };
  }

  // Sum entries within this window up to observedAt
  const winStart = new Date(win.startTime).getTime();
  const relevantEntries = entries.filter((e) => {
    const t = new Date(e.timestamp).getTime();
    return t >= winStart && t <= obsTime;
  });
  const context = buildSnapshotContext(relevantEntries, promos);

  return {
    tokens: {
      output: relevantEntries.reduce((s, e) => s + e.usage.output_tokens, 0),
      input: relevantEntries.reduce((s, e) => s + e.usage.input_tokens, 0),
      cacheWrite: relevantEntries.reduce((s, e) => s + e.usage.cache_creation_input_tokens, 0),
      cacheRead: relevantEntries.reduce((s, e) => s + e.usage.cache_read_input_tokens, 0),
      total: relevantEntries.reduce(
        (s, e) =>
          s +
          e.usage.input_tokens +
          e.usage.output_tokens +
          e.usage.cache_creation_input_tokens +
          e.usage.cache_read_input_tokens,
        0
        ),
      },
    normalizedTokens: context.normalizedTokens,
    cost: relevantEntries.reduce((s, e) => s + e.cost, 0),
    windowId: win.id,
    windowStart: win.startTime,
    peakStatus: context.peakStatus,
    messageCount: relevantEntries.length,
    peakSplit: context.peakSplit,
    modelBreakdown: buildModelBreakdown(relevantEntries),
    agentBreakdown: buildAgentBreakdown(relevantEntries),
  };
}

/**
 * Compute weekly token snapshot at a specific time.
 * Sums all entries within the matching weekly bucket up to `observedAt`.
 */
function computeWeeklySnapshotAt(
  observedAt: string,
  scope: "weekly-all" | "weekly-sonnet",
  preloaded?: UsageEntry[]
): {
  tokens: CalibrationPoint["tokens"];
  normalizedTokens: NonNullable<CalibrationPoint["normalizedTokens"]>;
  cost: number;
  windowStart: string | null;
  peakStatus: string;
  messageCount: number;
  peakSplit?: FiveHourWindow["peakSplit"];
  modelBreakdown: Record<string, ModelTokenBreakdown>;
  agentBreakdown: Record<string, ModelTokenBreakdown>;
} | null {
  const allEntries = preloaded ?? readAllUsageData();
  const isSonnet = scope === "weekly-sonnet";
  const entries = isSonnet
    ? allEntries.filter((e) => e.model.toLowerCase().includes("sonnet"))
    : allEntries;
  const promos = readPromos();
  const { all, sonnet } = buildWeeklyBuckets(allEntries, DEFAULT_WEEKLY_CONFIG, promos);
  const buckets = isSonnet ? sonnet : all;

  const obsTime = new Date(observedAt).getTime();

  // Find the bucket that contains observedAt
  const bucket = buckets.find((b) => {
    const start = new Date(b.weekStart).getTime();
    const end = new Date(b.weekEnd).getTime();
    return obsTime >= start && obsTime < end;
  });

  if (!bucket) return null;

  // Sum entries within this week up to observedAt
  const weekStart = new Date(bucket.weekStart).getTime();
  const relevant = entries.filter((e) => {
    const t = new Date(e.timestamp).getTime();
    return t >= weekStart && t <= obsTime;
  });

  if (relevant.length === 0) return null;

  const context = buildSnapshotContext(relevant, promos);

  return {
    tokens: {
      output: relevant.reduce((s, e) => s + e.usage.output_tokens, 0),
      input: relevant.reduce((s, e) => s + e.usage.input_tokens, 0),
      cacheWrite: relevant.reduce((s, e) => s + e.usage.cache_creation_input_tokens, 0),
      cacheRead: relevant.reduce((s, e) => s + e.usage.cache_read_input_tokens, 0),
      total: relevant.reduce(
        (s, e) =>
          s +
          e.usage.input_tokens +
          e.usage.output_tokens +
          e.usage.cache_creation_input_tokens +
          e.usage.cache_read_input_tokens,
        0
        ),
      },
    normalizedTokens: context.normalizedTokens,
    cost: relevant.reduce((s, e) => s + e.cost, 0),
    windowStart: bucket.weekStart,
    peakStatus: context.peakStatus,
    messageCount: relevant.length,
    peakSplit: context.peakSplit,
    modelBreakdown: buildModelBreakdown(relevant),
    agentBreakdown: buildAgentBreakdown(relevant),
  };
}

function computeSnapshotForCalibration(
  scope: CalibrationPoint["scope"],
  observedAt: string,
  preloaded?: UsageEntry[]
): CalibrationSnapshot | null {
  return scope === "5h"
    ? computeSnapshotAt(observedAt, preloaded)
    : computeWeeklySnapshotAt(observedAt, scope as "weekly-all" | "weekly-sonnet", preloaded);
}

function snapshotWindowId(snapshot: CalibrationSnapshot): number | null {
  return "windowId" in snapshot ? snapshot.windowId : null;
}

function applySnapshotToPoint(
  point: CalibrationPoint,
  snapshot: CalibrationSnapshot,
  _promos: PromoPeriod[],
  options?: { includeTokens?: boolean }
): boolean {
  const includeTokens = options?.includeTokens ?? true;
  const nextTokens = snapshot.tokens;
  const nextNormalized = snapshot.normalizedTokens;
  const nextCost = snapshot.cost;
  const nextWindowId = snapshotWindowId(snapshot);
  const nextWindowStart = snapshot.windowStart;
  const nextPeakStatus = snapshot.peakStatus as CalibrationPoint["peakStatus"];

  const hasModelBreakdown = "modelBreakdown" in snapshot && snapshot.modelBreakdown;
  const missingModelBreakdown = hasModelBreakdown && point.modelBreakdown == null;

  const changed =
    (includeTokens && JSON.stringify(point.tokens ?? null) !== JSON.stringify(nextTokens)) ||
    JSON.stringify(point.normalizedTokens ?? null) !== JSON.stringify(nextNormalized) ||
    point.cost !== nextCost ||
    point.windowId !== nextWindowId ||
    point.windowStart !== nextWindowStart ||
    point.peakStatus !== nextPeakStatus ||
    missingModelBreakdown;

  if (!changed) return false;

  if (includeTokens) {
    point.tokens = nextTokens;
  }
  point.normalizedTokens = nextNormalized;
  point.cost = nextCost;
  point.windowId = nextWindowId;
  point.windowStart = nextWindowStart;
  point.peakStatus = nextPeakStatus;
  if (hasModelBreakdown) {
    point.modelBreakdown = snapshot.modelBreakdown;
  }
  if ("agentBreakdown" in snapshot && snapshot.agentBreakdown) {
    point.agentBreakdown = snapshot.agentBreakdown;
  }

  return true;
}

function needsCalibrationRepair(point: CalibrationPoint): boolean {
  if (point.tokens == null || point.normalizedTokens == null) return true;
  if (point.modelBreakdown == null) return true;
  // Strip leftover promoMultiplier from old data
  if ("promoMultiplier" in point) return true;
  return false;
}

function repairCalibrationPoints(points: CalibrationPoint[]): {
  changed: boolean;
  backfilled: number;
  normalizedBackfilled: number;
  recomputed: number;
  failed: number;
} {
  const needsRepair = points.some((point) => needsCalibrationRepair(point));
  if (!needsRepair) {
    return {
      changed: false,
      backfilled: 0,
      normalizedBackfilled: 0,
      recomputed: 0,
      failed: 0,
    };
  }

  const allEntries = readAllUsageData();
  const promos = readPromos();

  let changed = false;
  let backfilled = 0;
  let normalizedBackfilled = 0;
  let recomputed = 0;
  let failed = 0;

  for (const point of points) {
    // Strip leftover promoMultiplier from old data
    if ("promoMultiplier" in point) {
      delete (point as Record<string, unknown>).promoMultiplier;
      changed = true;
      recomputed++;
    }

    if (!needsCalibrationRepair(point)) continue;

    const missingTokens = point.tokens == null;
    const missingNormalized = point.normalizedTokens == null;
    const snapshot = computeSnapshotForCalibration(point.scope, point.timestamp, allEntries);

    if (!snapshot) {
      failed++;
      continue;
    }

    const didChange = applySnapshotToPoint(point, snapshot, promos, {
      includeTokens: missingTokens,
    });
    if (!didChange) continue;

    changed = true;
    if (missingTokens) {
      backfilled++;
    } else if (missingNormalized) {
      normalizedBackfilled++;
    } else {
      recomputed++;
    }
  }

  return { changed, backfilled, normalizedBackfilled, recomputed, failed };
}

/** GET — return all calibration points */
export async function GET() {
  const file = readCalFile();
  const repair = repairCalibrationPoints(file.calibrations);
  if (repair.changed) {
    writeCalFile(file);
  }
  return NextResponse.json(file.calibrations);
}

/** POST — add a new calibration point (server computes snapshot) */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Accept either a full CalibrationPoint or a slim payload
    // Slim: { reportedPct, scope, observedAt }
    // Full: complete CalibrationPoint object
    if (body.id && body.tokens) {
      // Full CalibrationPoint — just save it
      const existing = readCalibrations();
      existing.push(body as CalibrationPoint);
      writeCalibrations(existing);
      return NextResponse.json({ ok: true, count: existing.length, point: body });
    }

    // Slim payload — compute snapshot server-side
    const { reportedPct, scope, observedAt } = body as {
      reportedPct: number;
      scope: string;
      observedAt: string;
    };

    if (!reportedPct || !scope || !observedAt) {
      return NextResponse.json(
        { error: "Missing: reportedPct, scope, observedAt" },
        { status: 400 }
      );
    }

    const promos = readPromos();
    const snapshot = computeSnapshotForCalibration(
      scope as CalibrationPoint["scope"],
      observedAt
    );

    if (!snapshot) {
      return NextResponse.json(
        { error: "No usage data found at this time for scope: " + scope },
        { status: 404 }
      );
    }

    const point: CalibrationPoint = {
      id: `cal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: observedAt,
      reportedPct,
      scope: scope as CalibrationPoint["scope"],
      tokens: snapshot.tokens,
      normalizedTokens: snapshot.normalizedTokens,
      cost: snapshot.cost,
      windowId: snapshotWindowId(snapshot),
      windowStart: snapshot.windowStart,
      peakStatus: snapshot.peakStatus as CalibrationPoint["peakStatus"],
      modelBreakdown: snapshot.modelBreakdown,
      agentBreakdown: snapshot.agentBreakdown,
    };

    const existing = readCalibrations();
    existing.push(point);
    writeCalibrations(existing);

    return NextResponse.json({
      ok: true,
      count: existing.length,
      point,
      snapshot,
    });
  } catch (error) {
    console.error("[calibrations] POST error:", error);
    return NextResponse.json(
      { error: "Failed to save calibration" },
      { status: 500 }
    );
  }
}

/** PATCH — repair stale calibration snapshots and promo normalization */
export async function PATCH() {
  try {
    const points = readCalibrations();
    const repair = repairCalibrationPoints(points);

    if (repair.changed) {
      writeCalibrations(points);
    }
    return NextResponse.json({
      ok: true,
      backfilled: repair.backfilled,
      normalizedBackfilled: repair.normalizedBackfilled,
      recomputed: repair.recomputed,
      failed: repair.failed,
      total: points.length,
    });
  } catch (error) {
    console.error("[calibrations] PATCH backfill error:", error);
    return NextResponse.json(
      { error: "Failed to backfill calibrations" },
      { status: 500 }
    );
  }
}

/** PUT — update a calibration point's reportedPct (and optionally re-snapshot at new timestamp), or patch anomalyFlag */
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { id, reportedPct, observedAt, anomalyFlag } = body as {
      id: string;
      reportedPct?: number;
      observedAt?: string;
      anomalyFlag?: import('@/lib/types').AnomalyFlag;
    };
    if (!id || (reportedPct == null && !observedAt && anomalyFlag === undefined)) {
      return NextResponse.json(
        { error: "Missing id; provide reportedPct, observedAt, and/or anomalyFlag" },
        { status: 400 }
      );
    }

    const existing = readCalibrations();
    const idx = existing.findIndex((p) => p.id === id);
    if (idx === -1) {
      return NextResponse.json({ error: "Calibration not found" }, { status: 404 });
    }

    const point = existing[idx];
    const newTimestamp = observedAt ?? point.timestamp;
    const timestampChanged = observedAt && observedAt !== point.timestamp;

    if (timestampChanged) {
      const promos = readPromos();
      const snapshot = computeSnapshotForCalibration(point.scope, newTimestamp);

      if (snapshot) {
        const updated: CalibrationPoint = {
          ...point,
          ...(reportedPct != null ? { reportedPct } : {}),
          timestamp: newTimestamp,
          tokens: snapshot.tokens,
          normalizedTokens: snapshot.normalizedTokens,
          cost: snapshot.cost,
          windowId: snapshotWindowId(snapshot),
          windowStart: snapshot.windowStart,
          peakStatus: snapshot.peakStatus as CalibrationPoint["peakStatus"],
          ...(anomalyFlag !== undefined ? { anomalyFlag } : {}),
        };
        existing[idx] = updated;
      } else {
        existing[idx] = {
          ...point,
          ...(reportedPct != null ? { reportedPct } : {}),
          timestamp: newTimestamp,
          ...(anomalyFlag !== undefined ? { anomalyFlag } : {}),
        };
      }
    } else {
      existing[idx] = {
        ...point,
        ...(reportedPct != null ? { reportedPct } : {}),
        ...(anomalyFlag !== undefined ? { anomalyFlag } : {}),
      };
    }

    writeCalibrations(existing);
    return NextResponse.json({ ok: true, point: existing[idx] });
  } catch (error) {
    console.error("[calibrations] PUT error:", error);
    return NextResponse.json({ error: "Failed to update calibration" }, { status: 500 });
  }
}

/** DELETE — remove a calibration point by id */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json(
        { error: "Missing id query parameter" },
        { status: 400 }
      );
    }

    const existing = readCalibrations();
    const filtered = existing.filter((p) => p.id !== id);

    if (filtered.length === existing.length) {
      return NextResponse.json(
        { error: "Calibration not found" },
        { status: 404 }
      );
    }

    writeCalibrations(filtered);
    return NextResponse.json({ ok: true, count: filtered.length });
  } catch (error) {
    console.error("[calibrations] DELETE error:", error);
    return NextResponse.json(
      { error: "Failed to delete calibration" },
      { status: 500 }
    );
  }
}
