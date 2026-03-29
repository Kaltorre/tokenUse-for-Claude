import { NextResponse } from "next/server";
import { analyzeUsage } from "@/lib/analyzer";
import { loadUsageEntriesFromStore, syncUsageStore } from "@/lib/reader";
import { readPromos } from "@/lib/promos";
import { UsageData } from "@/lib/types";
import { getUsageCacheContext, loadAnalyzedUsageCache, saveAnalyzedUsageCache } from "@/lib/usage-data-cache";

export const dynamic = "force-dynamic";

const CACHE_TTL = 60_000;
let memCache:
  | { data: UsageData; time: number; revision: number; promosMtimeMs: number }
  | null = null;

export async function GET() {
  try {
    const now = Date.now();
    const syncResult = syncUsageStore();
    const cacheContext = getUsageCacheContext(syncResult.meta);

    if (
      memCache &&
      now - memCache.time < CACHE_TTL &&
      memCache.revision === cacheContext.storeRevision &&
      memCache.promosMtimeMs === cacheContext.promosMtimeMs
    ) {
      return NextResponse.json(memCache.data);
    }

    const diskCached = loadAnalyzedUsageCache(syncResult.meta);
    if (diskCached) {
      memCache = {
        data: diskCached,
        time: now,
        revision: cacheContext.storeRevision,
        promosMtimeMs: cacheContext.promosMtimeMs,
      };
      return NextResponse.json(diskCached);
    }

    const t0 = Date.now();
    const entries = loadUsageEntriesFromStore();
    const promos = readPromos();
    const data = analyzeUsage(entries, promos);
    console.log(`[api/usage] Analyzed ${entries.length} entries in ${Date.now() - t0}ms`);

    memCache = {
      data,
      time: now,
      revision: cacheContext.storeRevision,
      promosMtimeMs: cacheContext.promosMtimeMs,
    };
    saveAnalyzedUsageCache(data, syncResult.meta);

    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[api/usage] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
