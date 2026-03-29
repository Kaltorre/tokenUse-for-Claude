import { NextResponse } from "next/server";
import { execFile } from "child_process";
import * as fs from "fs";
import path from "path";
import os from "os";

export async function POST(request: Request) {
  let targetDir: string;

  try {
    const body = await request.json();
    targetDir = typeof body.path === "string" ? body.path.trim() : "";
  } catch {
    targetDir = "";
  }

  if (!targetDir) {
    targetDir = path.join(os.homedir(), ".claude", "projects");
  }

  if (!fs.existsSync(targetDir)) {
    return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
  }

  return new Promise<NextResponse>((resolve) => {
    // explorer.exe exits with code 1 even on success — ignore errors
    execFile("explorer.exe", [targetDir], () => {
      resolve(NextResponse.json({ ok: true }));
    });
  });
}
