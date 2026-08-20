#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor } from "./doctor.js";
import { inspectRedmine } from "./inspect.js";
import {
  localBackup,
  localCommand,
  localCredentials,
  localReset,
  localRestore,
  localUp
} from "./local.js";

async function main(args: string[]): Promise<void> {
  const [group, command, ...rest] = args;
  if (!group || group === "help" || group === "--help") return help();
  if (group === "local") {
    const options = {
      stateDirectory: value(rest, "--state-dir") ?? ".feedback-redmine",
      demoPort: optionalNumber(rest, "--demo-port"),
      redminePort: optionalNumber(rest, "--redmine-port"),
      gatewayImage: value(rest, "--gateway-image"),
      demoImage: value(rest, "--demo-image")
    };
    if (command === "up") {
      const result = await localUp(options);
      process.stdout.write(`Feedbackデモ: ${result.demoUrl}\nRedmine管理画面: ${result.redmineUrl}\n資格情報: feedback-redmine local credentials --state-dir ${resolve(options.stateDirectory)}\n`);
      return;
    }
    if (command === "status" || command === "logs" || command === "down") return localCommand(options, command);
    if (command === "credentials") {
      const credentials = await localCredentials(options);
      process.stdout.write(`login: ${credentials.login}\npassword: ${credentials.password}\n`);
      return;
    }
    if (command === "reset") return localReset(options, rest.includes("--yes"));
    if (command === "backup") {
      const output = required(rest, "--output");
      await localBackup(options, resolve(output));
      process.stdout.write(`backupを作成しました: ${resolve(output)}\n`);
      return;
    }
    if (command === "restore") {
      await localRestore(options, resolve(required(rest, "--input")), rest.includes("--yes"));
      process.stdout.write("backupを復元しました\n");
      return;
    }
    throw new Error(`unknown local command: ${command ?? ""}`);
  }
  if (group === "inspect") {
    const manifestPath = resolve(required(args, "--manifest"));
    const apiKeyVariable = value(args, "--api-key-env") ?? "FEEDBACK_REDMINE_INSPECT_API_KEY";
    const apiKey = process.env[apiKeyVariable];
    if (!apiKey) throw new Error(`${apiKeyVariable}が未設定です`);
    const report = await inspectRedmine({ manifestPath, apiKey });
    const generatedDirectory = value(args, "--generated-dir");
    if (generatedDirectory) {
      if (!report.generated) throw new Error("不足または不一致があるためprofileを生成できません");
      const directory = resolve(generatedDirectory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(resolve(directory, "client-profile.json"), `${JSON.stringify(report.generated.clientProfile, null, 2)}\n`, { mode: 0o600 });
      await writeFile(resolve(directory, "server-profile.json"), `${JSON.stringify(report.generated.serverProfile, null, 2)}\n`, { mode: 0o600 });
      await writeFile(resolve(directory, "runtime-config.json"), `${JSON.stringify(report.generated.runtimeConfig, null, 2)}\n`, { mode: 0o644 });
    }
    await outputJson(report, value(args, "--output"));
    if (report.checks.some((check) => check.status !== "ok")) process.exitCode = 2;
    return;
  }
  if (group === "doctor") {
    const report = await runDoctor({
      origin: required(args, "--origin"),
      profileId: required(args, "--profile"),
      gatewayBasePath: value(args, "--gateway-base-path"),
      writeCanary: args.includes("--write-canary")
    });
    await outputJson(report, value(args, "--output"));
    if (report.checks.some((check) => check.status !== "ok")) process.exitCode = 2;
    return;
  }
  if (group === "provision" && command === "extract") {
    const output = resolve(required(rest, "--output"));
    await mkdir(dirname(output), { recursive: true });
    await copyFile(fileURLToPath(new URL("../assets/provision.rb", import.meta.url)), output);
    process.stdout.write(`${output}\n`);
    return;
  }
  throw new Error(`unknown command: ${args.join(" ")}`);
}

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const result = args[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${name}へ値を指定してください`);
  return result;
}

function required(args: string[], name: string): string {
  const result = value(args, name);
  if (!result) throw new Error(`${name}は必須です`);
  return result;
}

function optionalNumber(args: string[], name: string): number | undefined {
  const result = value(args, name);
  if (result === undefined) return undefined;
  const parsed = Number(result);
  if (!Number.isInteger(parsed)) throw new Error(`${name}はintegerで指定してください`);
  return parsed;
}

async function outputJson(value: unknown, output: string | undefined): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (!output) process.stdout.write(text);
  else await writeFile(resolve(output), text, { mode: 0o600 });
}

function help(): void {
  process.stdout.write(`Feedback Redmine導入・運用CLI

usage:
  feedback-redmine local up|status|logs|down|credentials [--state-dir <directory>]
  feedback-redmine local backup --output <new-directory> [--state-dir <directory>]
  feedback-redmine local restore --input <directory> --yes [--state-dir <directory>]
  feedback-redmine local reset --yes [--state-dir <directory>]
  feedback-redmine inspect --manifest <json> [--api-key-env <name>] [--generated-dir <directory>] [--output <json>]
  feedback-redmine doctor --origin <origin> --profile <id> [--write-canary] [--output <json>]
  feedback-redmine provision extract --output <provision.rb>
`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`[feedback-redmine] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
