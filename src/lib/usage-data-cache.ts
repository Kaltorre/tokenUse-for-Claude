import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { UsageData } from "./types";
import { UsageStoreMeta, getUsageStoreMeta } from "./usage-store";

const CACHE_DIR = path.join(os.homedir(), ".claude-monitor-cache");
const ANALYZED_CACHE = path.join(CACHE_DIR, "usage-data-cache.json");
const PROMOS_FILE = path.join(process.cwd(), "data", "promos.json");

interface UsageDataCacheEnvelope {
  version: 2;
  storeRevision: number;
  promosMtimeMs: number;
  savedAt: number;
  data: UsageData;
}

export interface UsageCacheContext {
  storeRevision: number;
  promosMtimeMs: number;
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getPromosMtimeMs(): number {
  try {
    return fs.existsSync(PROMOS_FILE) ? fs.statSync(PROMOS_FILE).mtimeMs : 0;
  } catch {
    return 0;
  }
}

export function getUsageCacheContext(meta?: UsageStoreMeta): UsageCacheContext {
  const storeMeta = meta ?? getUsageStoreMeta();
  return {
    storeRevision: storeMeta.revision,
    promosMtimeMs: getPromosMtimeMs(),
  };
}

export function loadAnalyzedUsageCache(meta?: UsageStoreMeta): UsageData | null {
  try {
    if (!fs.existsSync(ANALYZED_CACHE)) return null;

    const envelope = JSON.parse(fs.readFileSync(ANALYZED_CACHE, "utf-8")) as
      | UsageDataCacheEnvelope
      | UsageData;

    if (!("version" in envelope) || envelope.version !== 2) {
      return null;
    }

    const context = getUsageCacheContext(meta);
    if (envelope.storeRevision !== context.storeRevision) return null;
    if (envelope.promosMtimeMs !== context.promosMtimeMs) return null;

    return envelope.data;
  } catch {
    return null;
  }
}

export function saveAnalyzedUsageCache(data: UsageData, meta?: UsageStoreMeta) {
  try {
    ensureCacheDir();
    const context = getUsageCacheContext(meta);
    const envelope: UsageDataCacheEnvelope = {
      version: 2,
      storeRevision: context.storeRevision,
      promosMtimeMs: context.promosMtimeMs,
      savedAt: Date.now(),
      data,
    };
    fs.writeFileSync(ANALYZED_CACHE, JSON.stringify(envelope));
  } catch (error) {
    console.error("[usage-cache] Failed to save analyzed cache:", error);
  }
}
