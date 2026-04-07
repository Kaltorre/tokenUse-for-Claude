import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";

export const dynamic = "force-dynamic";

const DATA_DIR = path.join(process.cwd(), "data");
const USAGE_FILE = path.join(DATA_DIR, "claude-usage.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export interface ClaudeUsageData {
  fetchedAt: string;
  fiveHour: { utilization: number; resetsAt: string } | null;
  sevenDay: { utilization: number; resetsAt: string } | null;
  sevenDaySonnet: { utilization: number; resetsAt: string } | null;
  extraUsage: { isEnabled: boolean; utilization: number | null } | null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/** OPTIONS — CORS preflight */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

/** GET — return last fetched usage */
export async function GET() {
  try {
    if (!fs.existsSync(USAGE_FILE)) {
      return NextResponse.json({ data: null }, { headers: corsHeaders() });
    }
    const raw = JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8")) as ClaudeUsageData;
    return NextResponse.json({ data: raw }, { headers: corsHeaders() });
  } catch {
    return NextResponse.json({ data: null }, { headers: corsHeaders() });
  }
}

/** POST — receive usage data from bookmarklet */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Accept raw claude.ai API format
    const data: ClaudeUsageData = {
      fetchedAt: new Date().toISOString(),
      fiveHour: body.five_hour
        ? { utilization: body.five_hour.utilization, resetsAt: body.five_hour.resets_at }
        : null,
      sevenDay: body.seven_day
        ? { utilization: body.seven_day.utilization, resetsAt: body.seven_day.resets_at }
        : null,
      sevenDaySonnet: body.seven_day_sonnet
        ? { utilization: body.seven_day_sonnet.utilization, resetsAt: body.seven_day_sonnet.resets_at }
        : null,
      extraUsage: body.extra_usage
        ? { isEnabled: body.extra_usage.is_enabled, utilization: body.extra_usage.utilization }
        : null,
    };

    ensureDir();
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2), "utf-8");

    return NextResponse.json({ ok: true, data }, { headers: corsHeaders() });
  } catch (error) {
    console.error("[claude-usage] POST error:", error);
    return NextResponse.json(
      { error: "Failed to save usage data" },
      { status: 500, headers: corsHeaders() }
    );
  }
}
