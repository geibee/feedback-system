import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultLocalManifest } from "./manifest.js";
import { run } from "./run.js";

export type LocalOptions = {
  stateDirectory: string;
  demoPort?: number;
  redminePort?: number;
  gatewayImage?: string;
  demoImage?: string;
};

type LocalContext = {
  directory: string;
  compose: string;
  environment: string;
  project: string;
};

export async function localUp(options: LocalOptions): Promise<{ demoUrl: string; redmineUrl: string }> {
  const context = await ensureLocalState(options);
  compose(context, ["up", "-d", "--wait"]);
  return {
    demoUrl: `http://127.0.0.1:${options.demoPort ?? 4173}`,
    redmineUrl: `http://127.0.0.1:${options.redminePort ?? 3001}`
  };
}

export async function localCommand(options: LocalOptions, command: "status" | "logs" | "down"): Promise<void> {
  const context = await existingContext(options.stateDirectory);
  const args = command === "status" ? ["ps"] : command === "logs" ? ["logs", "--tail=200"] : ["down"];
  compose(context, args);
}

export async function localCredentials(options: LocalOptions): Promise<{ login: "admin"; password: string }> {
  const path = resolve(options.stateDirectory, "redmine-admin-password");
  return { login: "admin", password: (await readFile(path, "utf8")).trim() };
}

export async function localReset(options: LocalOptions, confirmed: boolean): Promise<void> {
  if (!confirmed) throw new Error("local resetには--yesが必要です");
  const context = await existingContext(options.stateDirectory);
  compose(context, ["down", "--volumes"]);
  for (const name of [
    ".env", "database.yml", "client-profile.json", "server-profile.json", "runtime-config.json", "redmine-api-key",
    "redmine-admin-password", "provision-result.json", "provision-plan.json"
  ]) await rm(resolve(context.directory, name), { force: true });
}

export async function localBackup(options: LocalOptions, outputDirectory: string): Promise<void> {
  const context = await existingContext(options.stateDirectory);
  try {
    await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  } catch {
    throw new Error(`backup出力先は存在しないdirectoryを指定してください: ${outputDirectory}`);
  }
  compose(context, ["stop", "feedback-redmine-demo", "feedback-redmine-gateway", "feedback-redmine"]);
  try {
    const database = composeBinary(context, ["exec", "-T", "feedback-redmine-db", "pg_dump", "-U", "redmine", "-d", "redmine", "-Fc"]);
    const files = composeBinary(context, ["run", "--rm", "--no-deps", "--entrypoint", "tar", "feedback-redmine", "-C", "/usr/src/redmine/files", "-czf", "-", "."]);
    const dbPath = resolve(outputDirectory, "redmine.dump");
    const filesPath = resolve(outputDirectory, "redmine-files.tar.gz");
    const statePath = resolve(outputDirectory, "local-state.json");
    await writeFile(dbPath, database, { mode: 0o600 });
    await writeFile(filesPath, files, { mode: 0o600 });
    const environmentValues = parseEnvironment(await readFile(context.environment, "utf8"));
    const localState = Buffer.from(`${JSON.stringify({
      schemaVersion: "1",
      participantSigningKey: environmentValues.FEEDBACK_PARTICIPANT_SIGNING_KEY,
      redmineApiKey: (await readFile(resolve(context.directory, "redmine-api-key"), "utf8")).trim(),
      redmineAdminPassword: (await readFile(resolve(context.directory, "redmine-admin-password"), "utf8")).trim(),
      installation: JSON.parse(await readFile(resolve(context.directory, "installation.json"), "utf8")),
      clientProfile: JSON.parse(await readFile(resolve(context.directory, "client-profile.json"), "utf8")),
      serverProfile: JSON.parse(await readFile(resolve(context.directory, "server-profile.json"), "utf8")),
      runtimeConfig: JSON.parse(await readFile(resolve(context.directory, "runtime-config.json"), "utf8"))
    }, null, 2)}\n`);
    await writeFile(statePath, localState, { mode: 0o600 });
    const manifest = {
      schemaVersion: "1",
      createdAt: new Date().toISOString(),
      redmineVersion: "7.0.0",
      database: { file: "redmine.dump", sha256: sha256(database), bytes: database.byteLength },
      files: { file: "redmine-files.tar.gz", sha256: sha256(files), bytes: files.byteLength },
      localState: { file: "local-state.json", sha256: sha256(localState), bytes: localState.byteLength, containsSecrets: true }
    };
    await writeFile(resolve(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  } finally {
    compose(context, ["up", "-d", "--wait"]);
  }
}

export async function localRestore(options: LocalOptions, inputDirectory: string, confirmed: boolean): Promise<void> {
  if (!confirmed) throw new Error("local restoreには--yesが必要です");
  const context = await ensureLocalState(options);
  const manifest = JSON.parse(await readFile(resolve(inputDirectory, "manifest.json"), "utf8")) as Record<string, any>;
  const database = await readFile(resolve(inputDirectory, "redmine.dump"));
  const files = await readFile(resolve(inputDirectory, "redmine-files.tar.gz"));
  const localStateBytes = await readFile(resolve(inputDirectory, "local-state.json"));
  if (manifest.schemaVersion !== "1" || manifest.database?.sha256 !== sha256(database) ||
      manifest.files?.sha256 !== sha256(files) || manifest.localState?.sha256 !== sha256(localStateBytes) ||
      manifest.localState?.containsSecrets !== true) {
    throw new Error("backup manifestまたはchecksumが不正です");
  }
  const localState = JSON.parse(localStateBytes.toString("utf8")) as Record<string, any>;
  if (localState.schemaVersion !== "1" || typeof localState.participantSigningKey !== "string" ||
      typeof localState.redmineApiKey !== "string" || typeof localState.redmineAdminPassword !== "string") {
    throw new Error("backupのローカル設定が不正です");
  }
  compose(context, ["down", "--volumes"]);
  compose(context, ["up", "-d", "--wait", "feedback-redmine-db"]);
  composeBinary(context, ["exec", "-T", "feedback-redmine-db", "pg_restore", "-U", "redmine", "-d", "redmine", "--clean", "--if-exists", "--no-owner"], database);
  composeBinary(context, ["run", "--rm", "--no-deps", "--entrypoint", "tar", "feedback-redmine", "-C", "/usr/src/redmine/files", "-xzf", "-"], files);
  await writeFile(resolve(context.directory, "redmine-api-key"), `${localState.redmineApiKey}\n`, { mode: 0o600 });
  await writeFile(resolve(context.directory, "redmine-admin-password"), `${localState.redmineAdminPassword}\n`, { mode: 0o600 });
  await writeFile(resolve(context.directory, "installation.json"), `${JSON.stringify(localState.installation, null, 2)}\n`, { mode: 0o600 });
  await writeFile(resolve(context.directory, "client-profile.json"), `${JSON.stringify(localState.clientProfile, null, 2)}\n`, { mode: 0o600 });
  await writeFile(resolve(context.directory, "server-profile.json"), `${JSON.stringify(localState.serverProfile, null, 2)}\n`, { mode: 0o600 });
  await writeFile(resolve(context.directory, "runtime-config.json"), `${JSON.stringify(localState.runtimeConfig, null, 2)}\n`, { mode: 0o644 });
  const restoredEnvironment = parseEnvironment(await readFile(context.environment, "utf8"));
  restoredEnvironment.FEEDBACK_PARTICIPANT_SIGNING_KEY = localState.participantSigningKey;
  await writeFile(context.environment, `${Object.entries(restoredEnvironment).map(([key, value]) => `${key}=${quoteEnvironment(value)}`).join("\n")}\n`, { mode: 0o600 });
  compose(context, ["up", "-d", "--wait"]);
}

async function ensureLocalState(options: LocalOptions): Promise<LocalContext> {
  const directory = resolve(options.stateDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const assets = fileURLToPath(new URL("../assets", import.meta.url));
  const composePath = resolve(directory, "compose.yaml");
  await copyFile(resolve(assets, "local-compose.yaml"), composePath);
  const installationPath = resolve(directory, "installation.json");
  try {
    await stat(installationPath);
  } catch {
    await writeFile(installationPath, `${JSON.stringify(defaultLocalManifest(), null, 2)}\n`, { mode: 0o600 });
  }
  const packageVersion = await readPackageVersion();
  const environmentPath = resolve(directory, ".env");
  try {
    await stat(environmentPath);
  } catch {
    const demoPort = port(options.demoPort ?? 4173, "demo port");
    const redminePort = port(options.redminePort ?? 3001, "Redmine port");
    const project = `feedback-redmine-${createHash("sha256").update(directory).digest("hex").slice(0, 12)}`;
    const values = {
      FEEDBACK_REDMINE_COMPOSE_PROJECT: project,
      FEEDBACK_REDMINE_STATE_DIR: directory,
      FEEDBACK_REDMINE_OPS_ASSETS: assets,
      FEEDBACK_REDMINE_HOST_UID: String(process.getuid?.() ?? 1000),
      FEEDBACK_REDMINE_HOST_GID: String(process.getgid?.() ?? 1000),
      FEEDBACK_REDMINE_DB_PASSWORD: secret(),
      FEEDBACK_REDMINE_SECRET_KEY_BASE: secret(64),
      FEEDBACK_PARTICIPANT_SIGNING_KEY: secret(48),
      FEEDBACK_REDMINE_ADMIN_PORT: String(redminePort),
      FEEDBACK_REDMINE_DEMO_PORT: String(demoPort),
      FEEDBACK_REDMINE_GATEWAY_IMAGE: options.gatewayImage ?? `ghcr.io/geibee/feedback-redmine-gateway:${packageVersion}`,
      FEEDBACK_REDMINE_DEMO_IMAGE: options.demoImage ?? `ghcr.io/geibee/feedback-redmine-demo:${packageVersion}`
    };
    await writeFile(environmentPath, `${Object.entries(values).map(([key, value]) => `${key}=${quoteEnvironment(value)}`).join("\n")}\n`, { mode: 0o600 });
  }
  const environmentValues = parseEnvironment(await readFile(environmentPath, "utf8"));
  let environmentChanged = false;
  if (!environmentValues.FEEDBACK_REDMINE_HOST_UID) {
    environmentValues.FEEDBACK_REDMINE_HOST_UID = String(process.getuid?.() ?? 1000);
    environmentChanged = true;
  }
  if (!environmentValues.FEEDBACK_REDMINE_HOST_GID) {
    environmentValues.FEEDBACK_REDMINE_HOST_GID = String(process.getgid?.() ?? 1000);
    environmentChanged = true;
  }
  if (environmentChanged) {
    await writeFile(environmentPath, `${Object.entries(environmentValues).map(([key, value]) => `${key}=${quoteEnvironment(value)}`).join("\n")}\n`, { mode: 0o600 });
  }
  const databaseConfigPath = resolve(directory, "database.yml");
  try {
    await stat(databaseConfigPath);
  } catch {
    const password = environmentValues.FEEDBACK_REDMINE_DB_PASSWORD;
    if (!password) throw new Error("ローカルRedmine DB passwordがありません");
    const databaseConfig = [
      "production:",
      "  adapter: postgresql",
      "  host: feedback-redmine-db",
      "  username: redmine",
      `  password: ${JSON.stringify(password)}`,
      "  database: redmine",
      "  encoding: utf8",
      ""
    ].join("\n");
    await writeFile(databaseConfigPath, databaseConfig, { mode: 0o600 });
  }
  return existingContext(directory);
}

async function existingContext(stateDirectory: string): Promise<LocalContext> {
  const directory = resolve(stateDirectory);
  const environment = resolve(directory, ".env");
  const composePath = resolve(directory, "compose.yaml");
  await stat(environment);
  await stat(composePath);
  const values = parseEnvironment(await readFile(environment, "utf8"));
  const project = values.FEEDBACK_REDMINE_COMPOSE_PROJECT;
  if (!project || !/^feedback-redmine-[a-f0-9]{12}$/u.test(project)) throw new Error("ローカルCompose project名が不正です");
  return { directory, compose: composePath, environment, project };
}

function compose(context: LocalContext, args: string[]): void {
  run("docker", ["compose", "--project-name", context.project, "--env-file", context.environment, "-f", context.compose, ...args], {
    cwd: context.directory,
    capture: false
  });
}

function composeBinary(context: LocalContext, args: string[], input?: Uint8Array): Buffer {
  const result = spawnSync("docker", ["compose", "--project-name", context.project, "--env-file", context.environment, "-f", context.compose, ...args], {
    cwd: context.directory,
    input,
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker composeが失敗しました: ${result.stderr.toString("utf8").trim()}`);
  return result.stdout;
}

async function readPackageVersion(): Promise<string> {
  const value = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof value.version !== "string") throw new Error("@feedback/redmine-ops versionが不正です");
  return value.version;
}

function parseEnvironment(value: string): Record<string, string> {
  return Object.fromEntries(value.split(/\r?\n/u).filter(Boolean).map((line) => {
    const index = line.indexOf("=");
    if (index < 1) throw new Error("ローカル環境ファイルが不正です");
    const raw = line.slice(index + 1);
    return [line.slice(0, index), raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1).replace(/'\\''/gu, "'") : raw];
  }));
}

function quoteEnvironment(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function port(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name}が不正です`);
  return value;
}

function secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
