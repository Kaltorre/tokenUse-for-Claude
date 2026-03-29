import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { analyzeUsage } from "@/lib/analyzer";
import { readAllUsageData } from "@/lib/reader";
import { readPromos } from "@/lib/promos";
import { UsageData } from "@/lib/types";

export const dynamic = "force-dynamic";

const CACHE_TTL = 60_000;
const CACHE_DIR = path.join(os.homedir(), ".claude-monitor-cache");
const ANALYZED_CACHE = path.join(CACHE_DIR, "usage-data-cache.json");
const RAW_CACHE = path.join(CACHE_DIR, "usage-cache.json");
const PROMOS_FILE = path.join(process.cwd(), "data", "promos.json");

let memCache: { data: UsageData; time: number } | null = null;

function loadDiskCache(): UsageData | null {
  try {
    if (!fs.existsSync(ANALYZED_CACHE)) return null;
    const analyzedMtime = fs.statSync(ANALYZED_CACHE).mtimeMs;
    // Stale if raw cache is newer (data changed)
    if (fs.existsSync(RAW_CACHE) && fs.statSync(RAW_CACHE).mtimeMs > analyzedMtime) return null;
    // Stale if promos config changed
    if (fs.existsSync(PROMOS_FILE) && fs.statSync(PROMOS_FILE).mtimeMs > analyzedMtime) return null;
    return JSON.parse(fs.readFileSync(ANALYZED_CACHE, "utf-8")) as UsageData;
  } catch {
    return null;
  }
}

function saveDiskCache(data: UsageData) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(ANALYZED_CACHE, JSON.stringify(data));
  } catch (e) {
    console.error("[api/usage] Failed to save disk cache:", e);
  }
}

export async function GET() {
  const now = Date.now();

  // In-memory cache (60s)
  if (memCache && now - memCache.time < CACHE_TTL) {
    return NextResponse.json(memCache.data);
  }

  // Disk cache (invalidated when raw data or promos change)
  const diskCached = loadDiskCache();
  if (diskCached) {
    memCache = { data: diskCached, time: now };
    return NextResponse.json(diskCached);
  }

  // Full computation
  const t0 = Date.now();
  const entries = readAllUsageData();
  const promos = readPromos();
  const data = analyzeUsage(entries, promos);
  console.log(`[api/usage] Analyzed ${entries.length} entries in ${Date.now() - t0}ms`);

  memCache = { data, time: now };
  saveDiskCache(data);

  return NextResponse.json(data);
}
