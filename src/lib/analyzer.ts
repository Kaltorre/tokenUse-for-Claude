import {
  UsageEntry,
  SessionStats,
  DailyStats,
  ProjectStats,
  ModelStats,
  OverviewStats,
  UsageData,
  PromoPeriod,
} from "./types";
import { getModelDisplayName } from "./pricing";
import { buildLimitsData } from "./limits-analyzer";

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

function totalTokens(e: UsageEntry): number {
  return (
    e.usage.input_tokens +
    e.usage.output_tokens +
    e.usage.cache_creation_input_tokens +
    e.usage.cache_read_input_tokens
  );
}

function sumTokenField(entries: UsageEntry[], field: keyof UsageEntry["usage"]): number {
  return entries.reduce((sum, e) => sum + (e.usage[field] || 0), 0);
}

function buildSessionStats(sessionId: string, entries: UsageEntry[]): SessionStats {
  const sorted = [...entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  const start = new Date(sorted[0].timestamp);
  const end = new Date(sorted[sorted.length - 1].timestamp);
  const durationMs = end.getTime() - start.getTime();

  const models: Record<string, number> = {};
  for (const e of entries) {
    const name = getModelDisplayName(e.model);
    models[name] = (models[name] || 0) + 1;
  }

  return {
    sessionId,
    project: entries[0].project,
    cwd: entries[0].cwd,
    startTime: sorted[0].timestamp,
    endTime: sorted[sorted.length - 1].timestamp,
    durationMinutes: Math.round(durationMs / 60000),
    totalTokens: entries.reduce((sum, e) => sum + totalTokens(e), 0),
    inputTokens: sumTokenField(entries, "input_tokens"),
    outputTokens: sumTokenField(entries, "output_tokens"),
    cacheCreationTokens: sumTokenField(entries, "cache_creation_input_tokens"),
    cacheReadTokens: sumTokenField(entries, "cache_read_input_tokens"),
    totalCost: entries.reduce((sum, e) => sum + e.cost, 0),
    messageCount: entries.length,
    models,
    entries: sorted,
  };
}

function buildDailyStats(entries: UsageEntry[]): DailyStats[] {
  const byDate = groupBy(entries, (e) => e.timestamp.slice(0, 10));
  const daily: DailyStats[] = [];

  for (const [date, dayEntries] of Object.entries(byDate)) {
    const sessions = new Set(dayEntries.map((e) => e.sessionId));
    const models: Record<string, number> = {};
    for (const e of dayEntries) {
      const name = getModelDisplayName(e.model);
      models[name] = (models[name] || 0) + totalTokens(e);
    }

    daily.push({
      date,
      totalTokens: dayEntries.reduce((sum, e) => sum + totalTokens(e), 0),
      inputTokens: sumTokenField(dayEntries, "input_tokens"),
      outputTokens: sumTokenField(dayEntries, "output_tokens"),
      cacheCreationTokens: sumTokenField(dayEntries, "cache_creation_input_tokens"),
      cacheReadTokens: sumTokenField(dayEntries, "cache_read_input_tokens"),
      totalCost: dayEntries.reduce((sum, e) => sum + e.cost, 0),
      sessionCount: sessions.size,
      messageCount: dayEntries.length,
      models,
    });
  }

  return daily.sort((a, b) => a.date.localeCompare(b.date));
}

function buildProjectStats(entries: UsageEntry[]): ProjectStats[] {
  const byProject = groupBy(entries, (e) => e.project);
  const stats: ProjectStats[] = [];

  for (const [project, projEntries] of Object.entries(byProject)) {
    const sessions = new Set(projEntries.map((e) => e.sessionId));
    stats.push({
      project,
      totalTokens: projEntries.reduce((sum, e) => sum + totalTokens(e), 0),
      totalCost: projEntries.reduce((sum, e) => sum + e.cost, 0),
      sessionCount: sessions.size,
      messageCount: projEntries.length,
      lastUsed: projEntries[projEntries.length - 1].timestamp,
    });
  }

  return stats.sort((a, b) => b.totalCost - a.totalCost);
}

function buildModelStats(entries: UsageEntry[]): ModelStats[] {
  const byModel = groupBy(entries, (e) => getModelDisplayName(e.model));
  const stats: ModelStats[] = [];

  for (const [model, modelEntries] of Object.entries(byModel)) {
    stats.push({
      model,
      totalTokens: modelEntries.reduce((sum, e) => sum + totalTokens(e), 0),
      inputTokens: sumTokenField(modelEntries, "input_tokens"),
      outputTokens: sumTokenField(modelEntries, "output_tokens"),
      totalCost: modelEntries.reduce((sum, e) => sum + e.cost, 0),
      messageCount: modelEntries.length,
    });
  }

  return stats.sort((a, b) => b.totalCost - a.totalCost);
}

function buildHourlyStats(entries: UsageEntry[]): { hour: number; tokens: number; cost: number; messages: number }[] {
  const hourly: { hour: number; tokens: number; cost: number; messages: number }[] = [];
  for (let h = 0; h < 24; h++) {
    hourly.push({ hour: h, tokens: 0, cost: 0, messages: 0 });
  }
  for (const e of entries) {
    const hour = new Date(e.timestamp).getHours();
    hourly[hour].tokens += totalTokens(e);
    hourly[hour].cost += e.cost;
    hourly[hour].messages += 1;
  }
  return hourly;
}

export function analyzeUsage(entries: UsageEntry[], promos: PromoPeriod[] = []): UsageData {
  const daily = buildDailyStats(entries);
  const sessionGroups = groupBy(entries, (e) => e.sessionId);
  const sessions = Object.entries(sessionGroups)
    .map(([id, es]) => buildSessionStats(id, es))
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  const projects = buildProjectStats(entries);
  const models = buildModelStats(entries);
  const hourly = buildHourlyStats(entries);

  // Overview calculations
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const todayEntries = entries.filter((e) => e.timestamp.startsWith(todayStr));

  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekEntries = entries.filter((e) => new Date(e.timestamp) >= weekAgo);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEntries = entries.filter((e) => new Date(e.timestamp) >= monthStart);

  const totalTok = entries.reduce((sum, e) => sum + totalTokens(e), 0);
  const totalCost = entries.reduce((sum, e) => sum + e.cost, 0);
  const totalSessions = sessions.length;

  const peakDay = daily.length > 0
    ? daily.reduce((max, d) => (d.totalTokens > max.totalTokens ? d : max), daily[0])
    : null;

  const overview: OverviewStats = {
    totalTokens: totalTok,
    totalCost,
    totalSessions,
    totalMessages: entries.length,
    avgTokensPerSession: totalSessions > 0 ? Math.round(totalTok / totalSessions) : 0,
    avgCostPerDay: daily.length > 0 ? totalCost / daily.length : 0,
    todayTokens: todayEntries.reduce((sum, e) => sum + totalTokens(e), 0),
    todayCost: todayEntries.reduce((sum, e) => sum + e.cost, 0),
    todaySessions: new Set(todayEntries.map((e) => e.sessionId)).size,
    thisWeekTokens: weekEntries.reduce((sum, e) => sum + totalTokens(e), 0),
    thisWeekCost: weekEntries.reduce((sum, e) => sum + e.cost, 0),
    thisMonthTokens: monthEntries.reduce((sum, e) => sum + totalTokens(e), 0),
    thisMonthCost: monthEntries.reduce((sum, e) => sum + e.cost, 0),
    topModel: models.length > 0 ? models[0].model : "N/A",
    topProject: projects.length > 0 ? projects[0].project : "N/A",
    peakDay: peakDay?.date || "N/A",
    peakDayTokens: peakDay?.totalTokens || 0,
  };

  const limits = buildLimitsData(entries, undefined, promos);

  return { overview, daily, sessions, projects, models, hourly, limits };
}
