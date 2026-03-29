import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { SourcesConfig, DataSource } from "@/lib/types";
import { loadSourcesConfig } from "@/lib/reader";

export const dynamic = "force-dynamic";

const DATA_DIR = path.join(process.cwd(), "data");
const SOURCES_FILE = path.join(DATA_DIR, "sources.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function writeSources(config: SourcesConfig): void {
  ensureDir();
  fs.writeFileSync(SOURCES_FILE, JSON.stringify(config, null, 2), "utf-8");
}

function validateSource(body: Partial<DataSource>): string | null {
  if (typeof body.path !== "string" || body.path.trim() === "") {
    return "Path is required.";
  }
  if (typeof body.label !== "string" || body.label.trim() === "") {
    return "Label is required.";
  }
  return null;
}

/** GET — return all sources */
export async function GET() {
  return NextResponse.json(loadSourcesConfig());
}

/** POST — add a new source */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<DataSource>;
    const validationError = validateSource(body);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const config = loadSourcesConfig();

    // Check for duplicate path
    const normalizedPath = body.path!.trim().replace(/\\/g, "/");
    const duplicate = config.sources.find(
      (s) => s.path.replace(/\\/g, "/") === normalizedPath
    );
    if (duplicate) {
      return NextResponse.json(
        { error: `Path already exists as "${duplicate.label}".` },
        { status: 400 }
      );
    }

    const source: DataSource = {
      id: `src_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      path: body.path!.trim(),
      label: body.label!.trim(),
      enabled: body.enabled !== false,
    };

    config.sources.push(source);
    writeSources(config);

    return NextResponse.json({ ok: true, source });
  } catch (error) {
    console.error("[sources] POST error:", error);
    return NextResponse.json({ error: "Failed to save source" }, { status: 500 });
  }
}

/** PUT — update an existing source */
export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as DataSource;
    if (!body.id) {
      return NextResponse.json({ error: "Missing source id." }, { status: 400 });
    }
    const validationError = validateSource(body);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const config = loadSourcesConfig();
    const idx = config.sources.findIndex((s) => s.id === body.id);
    if (idx === -1) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }

    config.sources[idx] = {
      ...body,
      path: body.path.trim(),
      label: body.label.trim(),
    };
    writeSources(config);
    return NextResponse.json({ ok: true, source: config.sources[idx] });
  } catch (error) {
    console.error("[sources] PUT error:", error);
    return NextResponse.json({ error: "Failed to update source" }, { status: 500 });
  }
}

/** PATCH — toggle primaryEnabled */
export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as { primaryEnabled?: boolean };
    if (typeof body.primaryEnabled !== "boolean") {
      return NextResponse.json({ error: "primaryEnabled must be a boolean" }, { status: 400 });
    }
    const config = loadSourcesConfig();
    config.primaryEnabled = body.primaryEnabled;
    writeSources(config);
    return NextResponse.json({ ok: true, primaryEnabled: config.primaryEnabled });
  } catch (error) {
    console.error("[sources] PATCH error:", error);
    return NextResponse.json({ error: "Failed to update primary source" }, { status: 500 });
  }
}

/** DELETE — remove a source by id */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Missing id param" }, { status: 400 });
    }
    const config = loadSourcesConfig();
    config.sources = config.sources.filter((s) => s.id !== id);
    writeSources(config);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[sources] DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete source" }, { status: 500 });
  }
}
