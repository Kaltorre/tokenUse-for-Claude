import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { PlanConfig, PlanPeriod } from "@/lib/types";

const DATA_DIR = path.join(process.cwd(), "data");
const PLANS_FILE = path.join(DATA_DIR, "plans.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readPlans(): PlanConfig {
  try {
    if (!fs.existsSync(PLANS_FILE)) return { periods: [] };
    const raw = fs.readFileSync(PLANS_FILE, "utf-8");
    return JSON.parse(raw) as PlanConfig;
  } catch {
    return { periods: [] };
  }
}

function writePlans(config: PlanConfig): void {
  ensureDir();
  fs.writeFileSync(PLANS_FILE, JSON.stringify(config, null, 2), "utf-8");
}

/** GET — return all plan periods */
export async function GET() {
  return NextResponse.json(readPlans());
}

/** POST — add a new plan period */
export async function POST(request: Request) {
  try {
    const body = await request.json() as Omit<PlanPeriod, "id">;
    const config = readPlans();

    const period: PlanPeriod = {
      id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      tier: body.tier,
      startDate: body.startDate,
      endDate: body.endDate ?? null,
      note: body.note,
    };

    config.periods.push(period);
    // Sort by startDate descending
    config.periods.sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
    writePlans(config);

    return NextResponse.json({ ok: true, period });
  } catch (error) {
    console.error("[plans] POST error:", error);
    return NextResponse.json({ error: "Failed to save plan" }, { status: 500 });
  }
}

/** PUT — update an existing plan period */
export async function PUT(request: Request) {
  try {
    const body = await request.json() as PlanPeriod;
    const config = readPlans();
    const idx = config.periods.findIndex((p) => p.id === body.id);
    if (idx === -1) {
      return NextResponse.json({ error: "Plan period not found" }, { status: 404 });
    }
    config.periods[idx] = body;
    config.periods.sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
    writePlans(config);
    return NextResponse.json({ ok: true, period: body });
  } catch (error) {
    console.error("[plans] PUT error:", error);
    return NextResponse.json({ error: "Failed to update plan" }, { status: 500 });
  }
}

/** DELETE — remove a plan period by id */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Missing id param" }, { status: 400 });
    }
    const config = readPlans();
    config.periods = config.periods.filter((p) => p.id !== id);
    writePlans(config);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[plans] DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete plan" }, { status: 500 });
  }
}
