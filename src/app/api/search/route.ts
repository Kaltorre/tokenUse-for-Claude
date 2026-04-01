import { NextRequest, NextResponse } from "next/server";
import { searchSessions } from "@/lib/session-search";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams.get("q") || "";
    const limit = Math.min(
      Number(req.nextUrl.searchParams.get("limit")) || 50,
      200
    );

    if (q.trim().length < 2) {
      return NextResponse.json([]);
    }

    const includeSubagents = req.nextUrl.searchParams.get("subagents") === "1";
    const days = Math.max(0, Number(req.nextUrl.searchParams.get("days")) || 30);
    const results = searchSessions(q, limit, 5, includeSubagents, days);
    return NextResponse.json(results);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Search failed";
    console.error("[api/search] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
