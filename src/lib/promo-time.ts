import { PromoSchedule } from "./types";

export const POLAND_TIME_ZONE = "Europe/Warsaw";

function lastWeekdayOfMonthUTC(year: number, month: number, weekday: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lastWeekday = new Date(Date.UTC(year, month, lastDay)).getUTCDay();
  return lastDay - ((lastWeekday - weekday + 7) % 7);
}

function warsawOffsetHours(date: Date): 1 | 2 {
  const year = date.getUTCFullYear();
  const dstStart = Date.UTC(year, 2, lastWeekdayOfMonthUTC(year, 2, 0), 1); // last Sunday of March, 01:00 UTC
  const dstEnd = Date.UTC(year, 9, lastWeekdayOfMonthUTC(year, 9, 0), 1);   // last Sunday of October, 01:00 UTC
  return date.getTime() >= dstStart && date.getTime() < dstEnd ? 2 : 1;
}

function isWarsawDstLocal(year: number, month: number, day: number, hour: number): boolean {
  const dstStartDay = lastWeekdayOfMonthUTC(year, 2, 0); // last Sunday of March
  const dstEndDay = lastWeekdayOfMonthUTC(year, 9, 0); // last Sunday of October

  if (month < 3 || month > 10) return false;
  if (month > 3 && month < 10) return true;

  if (month === 3) {
    if (day < dstStartDay) return false;
    if (day > dstStartDay) return true;
    return hour >= 2;
  }

  if (day < dstEndDay) return true;
  if (day > dstEndDay) return false;
  return hour < 3;
}

export function getWarsawTimeParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  dayOfWeek: number;
  isWeekday: boolean;
} {
  const localMs = date.getTime() + warsawOffsetHours(date) * 3_600_000;
  const local = new Date(localMs);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + 1;
  const day = local.getUTCDate();
  const hour = local.getUTCHours();
  const dayOfWeek = local.getUTCDay();

  return {
    year,
    month,
    day,
    hour,
    dayOfWeek,
    isWeekday: dayOfWeek >= 1 && dayOfWeek <= 5,
  };
}

export function matchesPromoScheduleInPoland(date: Date, schedule: PromoSchedule): boolean {
  if (schedule.type === "all-day-all-week") return true;

  const local = getWarsawTimeParts(date);

  if (schedule.type === "daily-hours") {
    return local.hour >= schedule.hourFrom && local.hour < schedule.hourTo;
  }

  if (!schedule.days.includes(local.dayOfWeek)) return false;
  if (schedule.hourFrom != null && schedule.hourTo != null) {
    const inRange = local.hour >= schedule.hourFrom && local.hour < schedule.hourTo;
    return schedule.excludeHours ? !inRange : inRange;
  }

  return true;
}

export function toPolishDateInput(iso: string): string {
  const local = getWarsawTimeParts(new Date(iso));
  return `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
}

export function fromPolishDateInput(value: string, boundary: "start" | "end"): string {
  const [year, month, day] = value.split("-").map(Number);
  const hour = boundary === "start" ? 0 : 23;
  const minute = boundary === "start" ? 0 : 59;
  const second = boundary === "start" ? 0 : 59;
  const offsetHours = isWarsawDstLocal(year, month, day, hour) ? 2 : 1;

  return new Date(
    Date.UTC(year, month - 1, day, hour - offsetHours, minute, second)
  ).toISOString();
}

export function formatPolishDate(iso: string): string {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: POLAND_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(iso));
}
