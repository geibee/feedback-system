import { spawnSync } from "node:child_process";

export function run(command: string, args: string[], options: { cwd?: string; input?: Uint8Array; capture?: boolean } = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: options.capture === false ? undefined : "utf8",
    stdio: options.capture === false ? "inherit" : [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    env: process.env,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(`${command}が失敗しました${stderr ? `: ${stderr}` : ""}`);
  }
  return typeof result.stdout === "string" ? result.stdout : "";
}
