import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  accountIdSchema,
  accountLabelSchema,
  accountProviderId,
  accountProviderLabel,
} from "../shared/accounts";

export const APP_DATA_DIR_NAME = "antigravity-cli";
export const OAUTH_TOKEN_FILENAME = "antigravity-oauth-token";
const DEFAULT_SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 0";

/**
 * Ambient Google/Gemini credential variables that should not leak across
 * isolated Antigravity account profiles (aligned with T3 Code's isolation).
 */
const REMOVED_ENV_KEYS = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "GEMINI_HOME",
  "ANTIGRAVITY_HOME",
  "ANTIGRAVITY_APP_DATA_DIR",
  "ANTIGRAVITY_LS_ADDRESS",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "AGY_CLI_FORCE_FILE_TOKEN_STORAGE",
  "AGY_CLI_DISABLE_AUTO_UPDATE",
  "ANTIGRAVITY_GEMINI_DIR",
]);

/** Non-credential global user files and skill dirs to link from ~/.gemini. */
const SHARED_USER_CONFIG_LINKS: ReadonlyArray<{
  segments: readonly string[];
  kind: "file" | "dir";
}> = [
  { segments: ["AGENTS.md"], kind: "file" },
  { segments: ["GEMINI.md"], kind: "file" },
  { segments: ["config", "skills.json"], kind: "file" },
  { segments: ["config", "skills"], kind: "dir" },
  { segments: [APP_DATA_DIR_NAME, "skills"], kind: "dir" },
];

const accountRecordSchema = z.object({
  id: accountIdSchema,
  label: accountLabelSchema,
  createdAt: z.string(),
});

const accountsStoreSchema = z.object({
  version: z.literal(1),
  accounts: z.array(accountRecordSchema),
});

export type AccountRecord = z.infer<typeof accountRecordSchema>;

export interface AccountProfile {
  readonly id: string;
  readonly label: string;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly profileDir: string;
  readonly createdAt: string;
}

export interface AccountStoreOptions {
  rootDir?: string;
  userHome?: string;
}

export function defaultAccountsRootDir(userHome = homedir()): string {
  return path.join(userHome, ".paseo", "better-paseo-antigravity");
}

export function accountsFilePath(rootDir = defaultAccountsRootDir()): string {
  return path.join(rootDir, "accounts.json");
}

export function accountProfileDir(
  id: string,
  rootDir = defaultAccountsRootDir(),
): string {
  const safeId = accountIdSchema.parse(id);
  return path.join(rootDir, "profiles", safeId);
}

export function accountTokenPath(profileDir: string): string {
  return path.join(profileDir, APP_DATA_DIR_NAME, OAUTH_TOKEN_FILENAME);
}

export function toAccountProfile(
  record: AccountRecord,
  rootDir = defaultAccountsRootDir(),
): AccountProfile {
  return {
    id: record.id,
    label: record.label,
    providerId: accountProviderId(record.id),
    providerLabel: accountProviderLabel(record.label),
    profileDir: accountProfileDir(record.id, rootDir),
    createdAt: record.createdAt,
  };
}

export function loadAccountRecordsSync(
  options: AccountStoreOptions = {},
): AccountRecord[] {
  const rootDir = options.rootDir ?? defaultAccountsRootDir(options.userHome);
  const file = accountsFilePath(rootDir);
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = accountsStoreSchema.parse(JSON.parse(raw));
    const seen = new Set<string>();
    return parsed.accounts.filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  } catch (error) {
    console.error(
      "better-paseo-antigravity: failed to read accounts.json",
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

export function loadAccountProfilesSync(
  options: AccountStoreOptions = {},
): AccountProfile[] {
  const rootDir = options.rootDir ?? defaultAccountsRootDir(options.userHome);
  return loadAccountRecordsSync(options).map((record) =>
    toAccountProfile(record, rootDir),
  );
}

export function saveAccountRecordsSync(
  accounts: readonly AccountRecord[],
  options: AccountStoreOptions = {},
): void {
  const rootDir = options.rootDir ?? defaultAccountsRootDir(options.userHome);
  const file = accountsFilePath(rootDir);
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({ version: 1, accounts }, null, 2) + "\n";
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, payload, { mode: 0o600, flush: true });
  renameSync(tmp, file);
}

export function addAccountRecord(
  input: { id: string; label: string },
  options: AccountStoreOptions = {},
): AccountProfile {
  const id = accountIdSchema.parse(input.id);
  const label = accountLabelSchema.parse(input.label);
  const rootDir = options.rootDir ?? defaultAccountsRootDir(options.userHome);
  const existing = loadAccountRecordsSync(options);
  if (existing.some((entry) => entry.id === id)) {
    throw new Error(`账号 ID "${id}" 已存在。`);
  }
  const record: AccountRecord = {
    id,
    label,
    createdAt: new Date().toISOString(),
  };
  const profile = toAccountProfile(record, rootDir);
  prepareAccountProfile(profile.profileDir, options.userHome);
  saveAccountRecordsSync([...existing, record], options);
  return profile;
}

export function removeAccountRecord(
  id: string,
  options: AccountStoreOptions & { deleteProfile?: boolean } = {},
): boolean {
  const safeId = accountIdSchema.parse(id);
  const rootDir = options.rootDir ?? defaultAccountsRootDir(options.userHome);
  const existing = loadAccountRecordsSync(options);
  const next = existing.filter((entry) => entry.id !== safeId);
  if (next.length === existing.length) return false;
  saveAccountRecordsSync(next, options);
  const profileDir = accountProfileDir(safeId, rootDir);
  if (options.deleteProfile) {
    rmSync(profileDir, { recursive: true, force: true });
  } else {
    clearAccountToken(profileDir);
  }
  return true;
}

export function isAccountSignedIn(profileDir: string): boolean {
  const tokenFile = accountTokenPath(profileDir);
  try {
    const info = lstatSync(tokenFile);
    return info.isFile() && !info.isSymbolicLink() && info.size > 0;
  } catch {
    return false;
  }
}

export function clearAccountToken(profileDir: string): boolean {
  const tokenFile = accountTokenPath(profileDir);
  try {
    const info = lstatSync(tokenFile);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    unlinkSync(tokenFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create an isolated GEMINI_HOME profile directory and link non-credential
 * user rules/skills from ~/.gemini (mirrors T3 Code's prepareAntigravityProfile).
 */
export function prepareAccountProfile(
  profileDir: string,
  userHome = homedir(),
): void {
  const resolvedProfile = path.resolve(profileDir);
  const appDataDir = path.join(resolvedProfile, APP_DATA_DIR_NAME);
  for (const dir of [resolvedProfile, appDataDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* ignore permission errors on special filesystems */
      }
    }
  }

  const realGeminiDir = path.resolve(userHome, ".gemini");
  if (realGeminiDir === resolvedProfile) return;

  for (const entry of SHARED_USER_CONFIG_LINKS) {
    const target = path.join(realGeminiDir, ...entry.segments);
    const link = path.join(resolvedProfile, ...entry.segments);
    syncUserConfigSymlink(target, link, entry.kind);
  }
}

function syncUserConfigSymlink(
  target: string,
  link: string,
  kind: "file" | "dir",
): void {
  let targetMatches = false;
  try {
    const targetStat = statSync(target);
    targetMatches = kind === "dir" ? targetStat.isDirectory() : targetStat.isFile();
  } catch {
    targetMatches = false;
  }

  let existingStat: ReturnType<typeof lstatSync> | undefined;
  try {
    existingStat = lstatSync(link);
  } catch {
    existingStat = undefined;
  }

  if (!targetMatches) {
    if (existingStat?.isSymbolicLink()) {
      try {
        unlinkSync(link);
      } catch {
        /* ignore */
      }
    }
    return;
  }

  if (existingStat) {
    if (existingStat.isSymbolicLink()) {
      try {
        const currentTarget = path.resolve(path.dirname(link), readlinkSync(link));
        if (currentTarget === target) return;
        unlinkSync(link);
      } catch {
        return;
      }
    } else if (kind === "dir" && existingStat.isDirectory()) {
      // Remove empty placeholder dir created by CLI before linking; never delete non-empty dirs.
      try {
        rmdirSync(link);
      } catch {
        return;
      }
    } else {
      // Preserve user-owned files inside the profile.
      return;
    }
  }

  try {
    mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
    symlinkSync(target, link, kind);
  } catch {
    /* non-fatal: profile remains usable without linked global config */
  }
}

/**
 * Build isolated environment for an Antigravity account profile without
 * touching HOME (so shell tools, git, ssh, and npm keep working normally).
 */
export function buildAccountEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  profileDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (REMOVED_ENV_KEYS.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  // agy 1.5.16+ requires AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 to store OAuth tokens in the
  // profile directory instead of the single OS keyring entry; keep SSH_CONNECTION and
  // AGY_ACP_FORCE_FILE_STORAGE as well for older 1.5.x builds.
  env.SSH_CONNECTION = baseEnv.SSH_CONNECTION || DEFAULT_SSH_CONNECTION;
  env.GEMINI_HOME = path.resolve(profileDir);
  env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE = "1";
  env.AGY_ACP_FORCE_FILE_STORAGE = "1";
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "1";
  return env;
}

export function accountAcpCommand(
  profileDir: string,
): readonly [string, ...string[]] {
  return [
    "agy",
    "acp",
    "--gemini-dir",
    path.resolve(profileDir),
    "--app-data-dir",
    APP_DATA_DIR_NAME,
    "--disable-telemetry",
  ];
}
