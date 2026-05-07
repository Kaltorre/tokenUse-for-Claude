import { DatabaseSync } from "node:sqlite";
import {
  DailyStats,
  ModelStats,
  ModelTokenBreakdown,
  ProjectStats,
  SessionStats,
} from "./types";
import { getModelDisplayName } from "./pricing";

interface DailyRow {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  messageCount: number;
  sessionCount: number;
}

interface DailyModelRow {
  date: string;
  model: string;
  tokens: number;
}

interface ModelRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  messageCount: number;
}

interface ProjectRow {
  project: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  messageCount: number;
  sessionCount: number;
  lastUsed: string;
}

interface ProjectModelRow {
  project: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  messageCount: number;
}

interface SessionRow {
  sessionId: string;
  project: string;
  cwd: string;
  startTime: string;
  endTime: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  messageCount: number;
}

interface SessionModelRow {
  sessionId: string;
  model: string;
  messageCount: number;
}

interface HourlyBucketRow {
  date: string;
  utcHour: number;
  tokens: number;
  cost: number;
  messages: number;
}

const TOTAL_TOKENS_EXPR =
  "(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens)";

function emptyModelBreakdown(): ModelTokenBreakdown {
  return {
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
}

function mergeBreakdown(target: ModelTokenBreakdown, src: ModelTokenBreakdown) {
  target.messageCount += src.messageCount;
  target.inputTokens += src.inputTokens;
  target.outputTokens += src.outputTokens;
  target.cacheCreationTokens += src.cacheCreationTokens;
  target.cacheReadTokens += src.cacheReadTokens;
  target.totalTokens += src.totalTokens;
  target.totalCost += src.totalCost;
}

export function loadDailyStatsFromDb(db: DatabaseSync): DailyStats[] {
  const rows = db
    .prepare(
      `
      SELECT
        substr(timestamp, 1, 10) AS date,
        SUM(input_tokens) AS inputTokens,
        SUM(output_tokens) AS outputTokens,
        SUM(cache_creation_tokens) AS cacheCreationTokens,
        SUM(cache_read_tokens) AS cacheReadTokens,
        SUM(${TOTAL_TOKENS_EXPR}) AS totalTokens,
        SUM(cost) AS totalCost,
        COUNT(*) AS messageCount,
        COUNT(DISTINCT session_id) AS sessionCount
      FROM usage_entries
      GROUP BY date
      ORDER BY date ASC
    `
    )
    .all() as unknown as DailyRow[];

  const modelRows = db
    .prepare(
      `
      SELECT
        substr(timestamp, 1, 10) AS date,
        model,
        SUM(${TOTAL_TOKENS_EXPR}) AS tokens
      FROM usage_entries
      GROUP BY date, model
    `
    )
    .all() as unknown as DailyModelRow[];

  const modelsByDate = new Map<string, Record<string, number>>();
  for (const row of modelRows) {
    const display = getModelDisplayName(row.model);
    let bucket = modelsByDate.get(row.date);
    if (!bucket) {
      bucket = {};
      modelsByDate.set(row.date, bucket);
    }
    bucket[display] = (bucket[display] || 0) + Number(row.tokens || 0);
  }

  return rows.map((row) => ({
    date: row.date,
    totalTokens: Number(row.totalTokens || 0),
    inputTokens: Number(row.inputTokens || 0),
    outputTokens: Number(row.outputTokens || 0),
    cacheCreationTokens: Number(row.cacheCreationTokens || 0),
    cacheReadTokens: Number(row.cacheReadTokens || 0),
    totalCost: Number(row.totalCost || 0),
    sessionCount: Number(row.sessionCount || 0),
    messageCount: Number(row.messageCount || 0),
    models: modelsByDate.get(row.date) ?? {},
  }));
}

export function loadModelStatsFromDb(db: DatabaseSync): ModelStats[] {
  const rows = db
    .prepare(
      `
      SELECT
        model,
        SUM(input_tokens) AS inputTokens,
        SUM(output_tokens) AS outputTokens,
        SUM(cache_creation_tokens) AS cacheCreationTokens,
        SUM(cache_read_tokens) AS cacheReadTokens,
        SUM(${TOTAL_TOKENS_EXPR}) AS totalTokens,
        SUM(cost) AS totalCost,
        COUNT(*) AS messageCount
      FROM usage_entries
      GROUP BY model
    `
    )
    .all() as unknown as ModelRow[];

  const merged = new Map<string, ModelStats>();
  for (const row of rows) {
    const display = getModelDisplayName(row.model);
    const existing = merged.get(display);
    if (existing) {
      existing.inputTokens += Number(row.inputTokens || 0);
      existing.outputTokens += Number(row.outputTokens || 0);
      existing.totalTokens += Number(row.totalTokens || 0);
      existing.totalCost += Number(row.totalCost || 0);
      existing.messageCount += Number(row.messageCount || 0);
    } else {
      merged.set(display, {
        model: display,
        totalTokens: Number(row.totalTokens || 0),
        inputTokens: Number(row.inputTokens || 0),
        outputTokens: Number(row.outputTokens || 0),
        totalCost: Number(row.totalCost || 0),
        messageCount: Number(row.messageCount || 0),
      });
    }
  }

  return [...merged.values()].sort((a, b) => b.totalCost - a.totalCost);
}

export function loadProjectStatsFromDb(db: DatabaseSync): ProjectStats[] {
  const rows = db
    .prepare(
      `
      SELECT
        project,
        SUM(input_tokens) AS inputTokens,
        SUM(output_tokens) AS outputTokens,
        SUM(cache_creation_tokens) AS cacheCreationTokens,
        SUM(cache_read_tokens) AS cacheReadTokens,
        SUM(${TOTAL_TOKENS_EXPR}) AS totalTokens,
        SUM(cost) AS totalCost,
        COUNT(*) AS messageCount,
        COUNT(DISTINCT session_id) AS sessionCount,
        MAX(timestamp) AS lastUsed
      FROM usage_entries
      GROUP BY project
    `
    )
    .all() as unknown as ProjectRow[];

  const projectModelRows = db
    .prepare(
      `
      SELECT
        project,
        model,
        SUM(input_tokens) AS inputTokens,
        SUM(output_tokens) AS outputTokens,
        SUM(cache_creation_tokens) AS cacheCreationTokens,
        SUM(cache_read_tokens) AS cacheReadTokens,
        SUM(${TOTAL_TOKENS_EXPR}) AS totalTokens,
        SUM(cost) AS totalCost,
        COUNT(*) AS messageCount
      FROM usage_entries
      GROUP BY project, model
    `
    )
    .all() as unknown as ProjectModelRow[];

  const modelsByProject = new Map<string, Record<string, ModelTokenBreakdown>>();
  for (const row of projectModelRows) {
    const display = getModelDisplayName(row.model);
    let bucket = modelsByProject.get(row.project);
    if (!bucket) {
      bucket = {};
      modelsByProject.set(row.project, bucket);
    }
    if (!bucket[display]) bucket[display] = emptyModelBreakdown();
    mergeBreakdown(bucket[display], {
      messageCount: Number(row.messageCount || 0),
      inputTokens: Number(row.inputTokens || 0),
      outputTokens: Number(row.outputTokens || 0),
      cacheCreationTokens: Number(row.cacheCreationTokens || 0),
      cacheReadTokens: Number(row.cacheReadTokens || 0),
      totalTokens: Number(row.totalTokens || 0),
      totalCost: Number(row.totalCost || 0),
    });
  }

  return rows
    .map((row) => ({
      project: row.project,
      totalTokens: Number(row.totalTokens || 0),
      inputTokens: Number(row.inputTokens || 0),
      outputTokens: Number(row.outputTokens || 0),
      cacheCreationTokens: Number(row.cacheCreationTokens || 0),
      cacheReadTokens: Number(row.cacheReadTokens || 0),
      totalCost: Number(row.totalCost || 0),
      sessionCount: Number(row.sessionCount || 0),
      messageCount: Number(row.messageCount || 0),
      lastUsed: row.lastUsed,
      models: modelsByProject.get(row.project) ?? {},
    }))
    .sort((a, b) => b.totalCost - a.totalCost);
}

export function loadSessionStatsFromDb(db: DatabaseSync): SessionStats[] {
  const rows = db
    .prepare(
      `
      SELECT
        session_id AS sessionId,
        MIN(project) AS project,
        MIN(cwd) AS cwd,
        MIN(timestamp) AS startTime,
        MAX(timestamp) AS endTime,
        SUM(input_tokens) AS inputTokens,
        SUM(output_tokens) AS outputTokens,
        SUM(cache_creation_tokens) AS cacheCreationTokens,
        SUM(cache_read_tokens) AS cacheReadTokens,
        SUM(${TOTAL_TOKENS_EXPR}) AS totalTokens,
        SUM(cost) AS totalCost,
        COUNT(*) AS messageCount
      FROM usage_entries
      GROUP BY session_id
    `
    )
    .all() as unknown as SessionRow[];

  const modelRows = db
    .prepare(
      `
      SELECT
        session_id AS sessionId,
        model,
        COUNT(*) AS messageCount
      FROM usage_entries
      GROUP BY session_id, model
    `
    )
    .all() as unknown as SessionModelRow[];

  const modelsBySession = new Map<string, Record<string, number>>();
  for (const row of modelRows) {
    const display = getModelDisplayName(row.model);
    let bucket = modelsBySession.get(row.sessionId);
    if (!bucket) {
      bucket = {};
      modelsBySession.set(row.sessionId, bucket);
    }
    bucket[display] = (bucket[display] || 0) + Number(row.messageCount || 0);
  }

  return rows
    .map((row) => {
      const startMs = new Date(row.startTime).getTime();
      const endMs = new Date(row.endTime).getTime();
      const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs)
        ? Math.max(0, endMs - startMs)
        : 0;
      return {
        sessionId: row.sessionId,
        project: row.project,
        cwd: row.cwd,
        startTime: row.startTime,
        endTime: row.endTime,
        durationMinutes: Math.round(durationMs / 60000),
        totalTokens: Number(row.totalTokens || 0),
        inputTokens: Number(row.inputTokens || 0),
        outputTokens: Number(row.outputTokens || 0),
        cacheCreationTokens: Number(row.cacheCreationTokens || 0),
        cacheReadTokens: Number(row.cacheReadTokens || 0),
        totalCost: Number(row.totalCost || 0),
        messageCount: Number(row.messageCount || 0),
        models: modelsBySession.get(row.sessionId) ?? {},
      };
    })
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
}

export function loadHourlyStatsFromDb(
  db: DatabaseSync
): { hour: number; tokens: number; cost: number; messages: number }[] {
  const rows = db
    .prepare(
      `
      SELECT
        substr(timestamp, 1, 10) AS date,
        CAST(substr(timestamp, 12, 2) AS INTEGER) AS utcHour,
        SUM(${TOTAL_TOKENS_EXPR}) AS tokens,
        SUM(cost) AS cost,
        COUNT(*) AS messages
      FROM usage_entries
      GROUP BY date, utcHour
    `
    )
    .all() as unknown as HourlyBucketRow[];

  const hourly: { hour: number; tokens: number; cost: number; messages: number }[] = [];
  for (let h = 0; h < 24; h++) {
    hourly.push({ hour: h, tokens: 0, cost: 0, messages: 0 });
  }

  for (const row of rows) {
    const dateParts = row.date.split("-");
    if (dateParts.length !== 3) continue;
    const utcMs = Date.UTC(
      Number(dateParts[0]),
      Number(dateParts[1]) - 1,
      Number(dateParts[2]),
      Number(row.utcHour ?? 0),
      0,
      0,
      0
    );
    const localHour = new Date(utcMs).getHours();
    const bucket = hourly[localHour];
    bucket.tokens += Number(row.tokens || 0);
    bucket.cost += Number(row.cost || 0);
    bucket.messages += Number(row.messages || 0);
  }

  return hourly;
}

export interface PeriodTotalsRow {
  totalTokens: number;
  totalCost: number;
  sessionCount: number;
}

export function loadPeriodTotalsFromDb(
  db: DatabaseSync,
  fromTimestamp: string
): PeriodTotalsRow {
  const row = db
    .prepare(
      `
      SELECT
        COALESCE(SUM(${TOTAL_TOKENS_EXPR}), 0) AS totalTokens,
        COALESCE(SUM(cost), 0) AS totalCost,
        COUNT(DISTINCT session_id) AS sessionCount
      FROM usage_entries
      WHERE timestamp >= ?
    `
    )
    .get(fromTimestamp) as unknown as PeriodTotalsRow;
  return {
    totalTokens: Number(row?.totalTokens || 0),
    totalCost: Number(row?.totalCost || 0),
    sessionCount: Number(row?.sessionCount || 0),
  };
}

export function loadGlobalTotalsFromDb(db: DatabaseSync): {
  totalTokens: number;
  totalCost: number;
  totalMessages: number;
} {
  const row = db
    .prepare(
      `
      SELECT
        COALESCE(SUM(${TOTAL_TOKENS_EXPR}), 0) AS totalTokens,
        COALESCE(SUM(cost), 0) AS totalCost,
        COUNT(*) AS totalMessages
      FROM usage_entries
    `
    )
    .get() as unknown as { totalTokens: number; totalCost: number; totalMessages: number };
  return {
    totalTokens: Number(row?.totalTokens || 0),
    totalCost: Number(row?.totalCost || 0),
    totalMessages: Number(row?.totalMessages || 0),
  };
}
