import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { UsageStoreMeta, getUsageStoreMeta } from "./usage-store";

const CACHE_DIR = path.join(os.homedir(), ".claude-monitor-cache");
const LEGACY_ANALYZED_CACHE = path.join(CACHE_DIR, "usage-data-cache.json");
const PROMOS_FILE = path.join(process.cwd(), "data", "promos.json");

export interface UsageCacheContext {
  storeRevision: number;
  promosMtimeMs: number;
}

let legacyCleanupDone = false;

function cleanupLegacyAnalyzedCache() {
  if (legacyCleanupDone) return;
  legacyCleanupDone = true;
  try {
    if (fs.existsSync(LEGACY_ANALYZED_CACHE)) {
      fs.unlinkSync(LEGACY_ANALYZED_CACHE);
    }
  } catch {
    // Best-effort cleanup; SQL aggregations make this file obsolete.
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
  cleanupLegacyAnalyzedCache();
  const storeMeta = meta ?? getUsageStoreMeta();
  return {
    storeRevision: storeMeta.revision,
    promosMtimeMs: getPromosMtimeMs(),
  };
}
