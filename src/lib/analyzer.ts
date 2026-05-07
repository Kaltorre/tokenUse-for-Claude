import { DatabaseSync } from "node:sqlite";
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
import { buildLimitsData } from "./limits-analyzer";
import {
  loadDailyStatsFromDb,
  loadHourlyStatsFromDb,
  loadModelStatsFromDb,
  loadProjectStatsFromDb,
  loadSessionStatsFromDb,
  loadGlobalTotalsFromDb,
  loadPeriodTotalsFromDb,
} from "./usage-aggregates";

export type AnalyzeProgressCallback = (
  message: string,
  current: number,
  total: number
) => void;

function buildOverviewFromAggregates(
  db: DatabaseSync,
  daily: DailyStats[],
  sessions: SessionStats[],
  models: ModelStats[],
  projects: ProjectStats[]
): OverviewStats {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const weekAgoIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const monthStartIso = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const globals = loadGlobalTotalsFromDb(db);
  const todayDaily = daily.find((d) => d.date === todayStr);
  const todayTotals = todayDaily
    ? {
        totalTokens: todayDaily.totalTokens,
        totalCost: todayDaily.totalCost,
        sessionCount: todayDaily.sessionCount,
      }
    : loadPeriodTotalsFromDb(db, `${todayStr}T00:00:00.000Z`);
  const weekTotals = loadPeriodTotalsFromDb(db, weekAgoIso);
  const monthTotals = loadPeriodTotalsFromDb(db, monthStartIso);

  const totalSessions = sessions.length;
  const peakDay = daily.length > 0
    ? daily.reduce((max, d) => (d.totalTokens > max.totalTokens ? d : max), daily[0])
    : null;

  return {
    totalTokens: globals.totalTokens,
    totalCost: globals.totalCost,
    totalSessions,
    totalMessages: globals.totalMessages,
    avgTokensPerSession: totalSessions > 0 ? Math.round(globals.totalTokens / totalSessions) : 0,
    avgCostPerDay: daily.length > 0 ? globals.totalCost / daily.length : 0,
    todayTokens: todayTotals.totalTokens,
    todayCost: todayTotals.totalCost,
    todaySessions: todayTotals.sessionCount,
    thisWeekTokens: weekTotals.totalTokens,
    thisWeekCost: weekTotals.totalCost,
    thisMonthTokens: monthTotals.totalTokens,
    thisMonthCost: monthTotals.totalCost,
    topModel: models.length > 0 ? models[0].model : "N/A",
    topProject: projects.length > 0 ? projects[0].project : "N/A",
    peakDay: peakDay?.date || "N/A",
    peakDayTokens: peakDay?.totalTokens || 0,
  };
}

export function analyzeUsage(
  db: DatabaseSync,
  entries: UsageEntry[],
  promos: PromoPeriod[] = [],
  onProgress?: AnalyzeProgressCallback
): UsageData {
  const totalSteps = 9;
  let step = 0;
  const report = (message: string) => {
    step += 1;
    onProgress?.(message, step, totalSteps);
  };

  const daily = loadDailyStatsFromDb(db);
  report("Built daily aggregates");

  const sessions = loadSessionStatsFromDb(db);
  report("Built session aggregates");

  const projects = loadProjectStatsFromDb(db);
  report("Built project aggregates");

  const models = loadModelStatsFromDb(db);
  report("Built model aggregates");

  const hourly = loadHourlyStatsFromDb(db);
  report("Built hourly aggregates");

  const overview = buildOverviewFromAggregates(db, daily, sessions, models, projects);
  report("Built overview summary");

  const limits = buildLimitsData(entries, undefined, promos, (limitsMessage, limitsStep, limitsTotal) => {
    const mappedCurrent = 6 + Math.min(limitsStep, limitsTotal);
    onProgress?.(limitsMessage, mappedCurrent, totalSteps);
    step = mappedCurrent;
  });

  return { overview, daily, sessions, projects, models, hourly, limits };
}
