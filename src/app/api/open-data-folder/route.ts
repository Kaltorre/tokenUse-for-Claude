import { NextResponse } from "next/server";
import { execFile } from "child_process";
import path from "path";
import os from "os";

export async function POST() {
  const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");

  return new Promise<NextResponse>((resolve) => {
    // explorer.exe exits with code 1 even on success — ignore errors
    execFile("explorer.exe", [claudeProjectsDir], () => {
      resolve(NextResponse.json({ ok: true }));
    });
  });
}
