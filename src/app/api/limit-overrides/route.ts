import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { LimitOverridesConfig, LimitOverrideEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "limit-overrides.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readOverrides(): LimitOverridesConfig {
  try {
    if (!fs.existsSync(FILE)) return { overrides: {} };
    const raw = fs.readFileSync(FILE, "utf-8");
    return JSON.parse(raw) as LimitOverridesConfig;
  } catch {
    return { overrides: {} };
  }
}

function writeOverrides(config: LimitOverridesConfig): void {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(config, null, 2), "utf-8");
}

/** GET — return all limit overrides */
export async function GET() {
  return NextResponse.json(readOverrides());
}

/** PUT — set override for a specific tier:scope key */
export async function PUT(request: Request) {
  try {
    const body = await request.json() as {
      key: string; // e.g. "max20:5h"
      entry: LimitOverrideEntry;
    };
    if (!body.key) {
      return NextResponse.json({ error: "Missing key" }, { status: 400 });
    }
    const config = readOverrides();

    // Clean nulls — remove fields set to null
    const clean: LimitOverrideEntry = {};
    if (body.entry.costLimit != null) clean.costLimit = body.entry.costLimit;
    if (body.entry.outputLimit != null) clean.outputLimit = body.entry.outputLimit;
    if (body.entry.inputOutputLimit != null) clean.inputOutputLimit = body.entry.inputOutputLimit;
    if (body.entry.totalLimit != null) clean.totalLimit = body.entry.totalLimit;

    if (Object.keys(clean).length === 0) {
      delete config.overrides[body.key];
    } else {
      config.overrides[body.key] = { ...config.overrides[body.key], ...clean };
    }

    writeOverrides(config);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[limit-overrides] PUT error:", error);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}

/** DELETE — remove override for a specific tier:scope key, or a single field */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get("key");
    const field = searchParams.get("field"); // optional: costLimit, outputLimit, etc.
    if (!key) {
      return NextResponse.json({ error: "Missing key param" }, { status: 400 });
    }
    const config = readOverrides();
    if (field && config.overrides[key]) {
      delete (config.overrides[key] as Record<string, unknown>)[field];
      if (Object.keys(config.overrides[key]).length === 0) {
        delete config.overrides[key];
      }
    } else {
      delete config.overrides[key];
    }
    writeOverrides(config);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[limit-overrides] DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}
