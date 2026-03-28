import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { SessionOverrides, SessionOverrideEntry } from "@/lib/types";

const DATA_DIR = path.join(process.cwd(), "data");
const CAL_FILE = path.join(DATA_DIR, "calibrations.json");

export const dynamic = "force-dynamic";

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

type CalibrationFile = {
  calibrations: unknown[];
  session_overrides: SessionOverrides;
};

function emptyOverrides(): SessionOverrides {
  return { weekly: {}, "5h": {} };
}

function readCalFile(): CalibrationFile {
  try {
    if (!fs.existsSync(CAL_FILE)) return { calibrations: [], session_overrides: emptyOverrides() };
    const raw = fs.readFileSync(CAL_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { calibrations: parsed, session_overrides: emptyOverrides() };
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

/** GET — return all session overrides */
export async function GET() {
  const file = readCalFile();
  return NextResponse.json(file.session_overrides, {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

/**
 * PUT — set a single session override
 * Body: { type: "weekly" | "5h", key: string, start: string, end: string }
 */
export async function PUT(request: Request) {
  try {
    const body = await request.json() as {
      type: "weekly" | "5h";
      key: string;
      start: string;
      end: string;
    };

    const { type, key, start, end } = body;

    if (!type || !key || !start || !end) {
      return NextResponse.json(
        { error: "Missing required fields: type, key, start, end" },
        { status: 400 }
      );
    }

    if (type !== "weekly" && type !== "5h") {
      return NextResponse.json(
        { error: "type must be 'weekly' or '5h'" },
        { status: 400 }
      );
    }

    const entry: SessionOverrideEntry = { start, end };
    const file = readCalFile();
    file.session_overrides[type][key] = entry;
    writeCalFile(file);

    return NextResponse.json({ ok: true, type, key, entry });
  } catch (error) {
    console.error("[session-overrides] PUT error:", error);
    return NextResponse.json(
      { error: "Failed to save session override" },
      { status: 500 }
    );
  }
}

/**
 * DELETE — remove a single session override
 * Query: ?type=weekly|5h&key=...
 */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") as "weekly" | "5h" | null;
    const key = searchParams.get("key");

    if (!type || !key) {
      return NextResponse.json(
        { error: "Missing query params: type, key" },
        { status: 400 }
      );
    }

    if (type !== "weekly" && type !== "5h") {
      return NextResponse.json(
        { error: "type must be 'weekly' or '5h'" },
        { status: 400 }
      );
    }

    const file = readCalFile();
    delete file.session_overrides[type][key];
    writeCalFile(file);

    return NextResponse.json({ ok: true, type, key });
  } catch (error) {
    console.error("[session-overrides] DELETE error:", error);
    return NextResponse.json(
      { error: "Failed to delete session override" },
      { status: 500 }
    );
  }
}
