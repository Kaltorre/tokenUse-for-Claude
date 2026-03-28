import { PlanPeriod, PlanTier } from "@/lib/types";

export function getPlanForDate(date: string, periods: PlanPeriod[]): PlanPeriod | null {
  const t = new Date(date).getTime();
  for (const p of periods) {
    const start = new Date(p.startDate).getTime();
    const end = p.endDate ? new Date(p.endDate).getTime() : Infinity;
    if (t >= start && t <= end) return p;
  }
  return null;
}

export function getPlanTierForDate(date: string, periods: PlanPeriod[]): PlanTier | null {
  return getPlanForDate(date, periods)?.tier ?? null;
}

/** Standard ISO week key: YYYY-WNN */
export function weekKeyFromDate(dateStr: string): string {
  const date = new Date(dateStr);
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo.toString().padStart(2, "0")}`;
}
