import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { PromoConfig, PromoPeriod } from "@/lib/types";

const DATA_DIR = path.join(process.cwd(), "data");
const PROMOS_FILE = path.join(DATA_DIR, "promos.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readPromos(): PromoConfig {
  try {
    if (!fs.existsSync(PROMOS_FILE)) return { periods: [] };
    const raw = fs.readFileSync(PROMOS_FILE, "utf-8");
    return JSON.parse(raw) as PromoConfig;
  } catch {
    return { periods: [] };
  }
}

function writePromos(config: PromoConfig): void {
  ensureDir();
  fs.writeFileSync(PROMOS_FILE, JSON.stringify(config, null, 2), "utf-8");
}

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isValidHour(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

function validateSchedule(schedule: PromoPeriod["schedule"] | undefined): string | null {
  if (!schedule) return "Missing schedule.";

  if (schedule.type === "all-day-all-week") {
    return null;
  }

  if (schedule.type === "daily-hours") {
    if (!isValidHour(schedule.hourFrom, 23)) return "Hour from must be between 0 and 23.";
    if (!isValidHour(schedule.hourTo, 24) || schedule.hourTo < 1) {
      return "Hour to must be between 1 and 24.";
    }
    if (schedule.hourFrom >= schedule.hourTo) {
      return "Hour from must be earlier than hour to.";
    }
    return null;
  }

  if (!Array.isArray(schedule.days) || schedule.days.length === 0) {
    return "Select at least one day.";
  }
  if (schedule.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return "Days must be between 0 and 6.";
  }

  const hasHours = schedule.hourFrom != null || schedule.hourTo != null;
  if (!hasHours) return null;

  if (!isValidHour(schedule.hourFrom, 23)) return "Hour from must be between 0 and 23.";
  if (!isValidHour(schedule.hourTo, 24) || schedule.hourTo < 1) {
    return "Hour to must be between 1 and 24.";
  }
  if (schedule.hourFrom >= schedule.hourTo) {
    return "Hour from must be earlier than hour to.";
  }

  return null;
}

function validatePromoInput(body: Partial<PromoPeriod>): string | null {
  if (typeof body.name !== "string" || body.name.trim() === "") {
    return "Name is required.";
  }
  if (!isValidIsoTimestamp(body.dateFrom) || !isValidIsoTimestamp(body.dateTo)) {
    return "Date range is invalid.";
  }
  if (new Date(body.dateFrom).getTime() > new Date(body.dateTo).getTime()) {
    return "Date from must be earlier than or equal to date to.";
  }
  if (typeof body.multiplier !== "number" || !Number.isFinite(body.multiplier) || body.multiplier < 1) {
    return "Multiplier must be at least 1.";
  }

  return validateSchedule(body.schedule);
}

/** GET — return all promo periods */
export async function GET() {
  return NextResponse.json(readPromos());
}

/** POST — add a new promo period */
export async function POST(request: Request) {
  try {
    const body = await request.json() as Omit<PromoPeriod, "id">;
    const validationError = validatePromoInput(body);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
    const config = readPromos();

    const period: PromoPeriod = {
      id: `promo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: body.name.trim(),
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      schedule: body.schedule,
      multiplier: body.multiplier,
    };

    config.periods.push(period);
    // Promos are ordered as entered (no sorting)
    writePromos(config);

    return NextResponse.json({ ok: true, period });
  } catch (error) {
    console.error("[promos] POST error:", error);
    return NextResponse.json({ error: "Failed to save promo" }, { status: 500 });
  }
}

/** PUT — update an existing promo period */
export async function PUT(request: Request) {
  try {
    const body = await request.json() as PromoPeriod;
    if (!body.id) {
      return NextResponse.json({ error: "Missing promo id." }, { status: 400 });
    }
    const validationError = validatePromoInput(body);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
    const config = readPromos();
    const idx = config.periods.findIndex((p) => p.id === body.id);
    if (idx === -1) {
      return NextResponse.json({ error: "Promo period not found" }, { status: 404 });
    }
    config.periods[idx] = { ...body, name: body.name.trim() };
    writePromos(config);
    return NextResponse.json({ ok: true, period: body });
  } catch (error) {
    console.error("[promos] PUT error:", error);
    return NextResponse.json({ error: "Failed to update promo" }, { status: 500 });
  }
}

/** DELETE — remove a promo period by id */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Missing id param" }, { status: 400 });
    }
    const config = readPromos();
    config.periods = config.periods.filter((p) => p.id !== id);
    writePromos(config);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[promos] DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete promo" }, { status: 500 });
  }
}
