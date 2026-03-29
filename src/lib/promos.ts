import * as fs from "fs";
import * as path from "path";
import { PromoPeriod } from "./types";

const PROMOS_FILE = path.join(process.cwd(), "data", "promos.json");

export function readPromos(): PromoPeriod[] {
  try {
    if (!fs.existsSync(PROMOS_FILE)) return [];
    return (JSON.parse(fs.readFileSync(PROMOS_FILE, "utf-8")) as { periods: PromoPeriod[] }).periods ?? [];
  } catch {
    return [];
  }
}
