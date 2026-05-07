import {
  getUsageStoreDb,
  loadUsageEntriesFromStore,
  ProgressCallback,
  ProgressStep,
  syncUsageStore,
} from "@/lib/reader";
import { analyzeUsage } from "@/lib/analyzer";
import { readPromos } from "@/lib/promos";

export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      function send(event: string, data: unknown) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      try {
        const onProgress: ProgressCallback = (step, message, current, total) => {
          send("progress", { step, message, current, total });
        };

        syncUsageStore(onProgress);

        const db = getUsageStoreDb();
        const entries = loadUsageEntriesFromStore();

        send("progress", {
          step: "analyze" satisfies ProgressStep,
          message: `Analyzing ${entries.length} entries...`,
          current: 0,
          total: 9,
        });
        const promos = readPromos();
        const data = analyzeUsage(db, entries, promos, (message, current, total) => {
          send("progress", {
            step: "analyze" satisfies ProgressStep,
            message,
            current,
            total,
          });
        });

        send("done", data);
      } catch (e) {
        send("error", { message: e instanceof Error ? e.message : "Unknown error" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
