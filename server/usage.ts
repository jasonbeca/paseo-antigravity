import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { execCommand } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageReport,
  type UsageSourceRegistration,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { BASE_PROVIDER_ID, BASE_PROVIDER_LABEL } from "../shared/accounts";
import {
  APP_DATA_DIR_NAME,
  buildAccountEnv,
  defaultAccountsRootDir,
  isAccountSignedIn,
  type AccountProfile,
} from "./accounts";

const USAGE_CACHE_FILENAME = "paseo-usage-cache.json";
const DEFAULT_USAGE_CACHE_FILENAME = "default-usage-cache.json";
export const DEFAULT_REFRESH_COOLDOWN_MS = 60_000;

const input = z.object({ cachePath: z.string().min(1) }).strict();

const responseSchema = z.object({
  status: z.string(),
  error: z.string().optional(),
  response: z.string().optional(),
  command: z
    .object({
      name: z.literal("usage"),
      data: z.object({
        groups: z.array(
          z.object({
            name: z.string(),
            buckets: z.array(
              z.object({
                id: z.string().min(1),
                name: z.string(),
                window: z.string(),
                remaining_fraction: z.number().min(0).max(1).nullish(),
                reset_time: z.string().nullish(),
                disabled: z.boolean().optional(),
              }),
            ),
          }),
        ),
      }),
    })
    .optional(),
});

const cachedWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  shortLabel: z.string().optional(),
  summary: z.boolean().optional(),
  usedPct: z.number().nullable().optional(),
  remainingPct: z.number().nullable().optional(),
  resetsAt: z.string().nullable().optional(),
  durationSeconds: z.number().optional(),
  tone: z.enum(["default", "ok", "warning", "danger"]).optional(),
});

const cachedUsageFileSchema = z.object({
  version: z.literal(1),
  fetchedAt: z.string(),
  windows: z.array(cachedWindowSchema),
});

export interface CachedUsageSnapshot {
  readonly fetchedAt: string;
  readonly windows: UsageWindow[];
}

export function accountUsageCachePath(profileDir: string): string {
  return path.join(path.resolve(profileDir), APP_DATA_DIR_NAME, USAGE_CACHE_FILENAME);
}

export function defaultUsageCachePath(userHome = homedir()): string {
  return path.join(defaultAccountsRootDir(userHome), DEFAULT_USAGE_CACHE_FILENAME);
}

export function readUsageCacheFile(filePath: string): CachedUsageSnapshot | undefined {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = cachedUsageFileSchema.parse(JSON.parse(raw));
    return {
      fetchedAt: parsed.fetchedAt,
      windows: parsed.windows,
    };
  } catch {
    return undefined;
  }
}

function writeUsageCacheFile(
  filePath: string,
  snapshot: CachedUsageSnapshot,
): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ version: 1, ...snapshot }, null, 2) + "\n",
    { mode: 0o600, flush: true },
  );
  renameSync(tmp, filePath);
}

function formatWindowLabel(name: string, window: string): string {
  if (window.trim().toLowerCase() === "5h") return "5h";
  return name.trim().replace(/(?:\s+Limit)?\s+Remaining$/i, "");
}

function shortWindow(window: string): string {
  const trimmed = window.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === "weekly") return "wk";
  if (normalized === "monthly") return "mo";
  return trimmed;
}

function windowDurationSeconds(window: string): number | undefined {
  switch (window.trim().toLowerCase()) {
    case "5h":
      return 5 * 3600;
    case "weekly":
      return 7 * 86400;
    default:
      return undefined;
  }
}

function formatGroupLabel(name: string): string {
  return name
    .trim()
    .replace(/(?:^|\s+)models$/i, "")
    .trim();
}

function formatShortLabel(groupLabel: string, window: string): string {
  const period = shortWindow(window);
  return groupLabel ? `${groupLabel} ${period}` : period;
}

function normalizeResetTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return value;
}

function formatSummaryText(windows: readonly UsageWindow[]): string {
  const parts = windows
    .filter((w) => typeof w.usedPct === "number")
    .slice(0, 4)
    .map((w) => `${w.shortLabel || w.label} ${Math.round(w.usedPct!)}%`);
  return parts.length > 0 ? parts.join(" · ") : "已更新";
}

const ISOLATED_USAGE_STRIPPED_ENV_KEYS = new Set([
  "XDG_CONFIG_HOME",
  "ANTIGRAVITY_HOME",
  "ANTIGRAVITY_APP_DATA_DIR",
  "ANTIGRAVITY_GEMINI_DIR",
  "ANTIGRAVITY_LS_ADDRESS",
  "ANTIGRAVITY_AGENT",
  "ANTIGRAVITY_CONVERSATION_ID",
  "ANTIGRAVITY_TRAJECTORY_ID",
]);

/**
 * `agy -p /usage` (CLI print mode) ignores `GEMINI_HOME` and does not accept
 * `--gemini-dir`; it always reads credentials from `<HOME>/.gemini/antigravity-cli`.
 * Run print-mode usage inside an ephemeral synthetic HOME whose `.gemini` points
 * to the account's isolated profile directory so every account reports its own quota.
 */
async function withIsolatedUsageHome<T>(
  baseEnv: Readonly<Record<string, string>>,
  profileDir: string,
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const tempHome = mkdtempSync(path.join(tmpdir(), "paseo-agy-usage-"));
  const geminiLink = path.join(tempHome, ".gemini");
  try {
    symlinkSync(
      path.resolve(profileDir),
      geminiLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(baseEnv)) {
      if (ISOLATED_USAGE_STRIPPED_ENV_KEYS.has(key.toUpperCase())) continue;
      env[key] = value;
    }
    env.HOME = tempHome;
    if (process.platform === "win32") {
      env.USERPROFILE = tempHome;
    }
    return await fn(env);
  } finally {
    try {
      unlinkSync(geminiLink);
    } catch {
      /* ignore if symlink was never created */
    }
    try {
      rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

export interface RefreshUsageResult {
  readonly fetchedAt: string;
  readonly report: UsageReport;
  readonly summary: string;
  readonly fromCache: boolean;
  readonly cooldownRemainingSec?: number;
}

export class Usage {
  private lastLaunch?: ProviderLaunch;
  private inFlight?: Promise<RefreshUsageResult>;
  private readonly account?: AccountProfile;
  private readonly userHome: string;
  private readonly cooldownMs: number;

  constructor(
    account?: AccountProfile,
    userHome = homedir(),
    cooldownMs = DEFAULT_REFRESH_COOLDOWN_MS,
  ) {
    this.account = account;
    this.userHome = userHome;
    this.cooldownMs = cooldownMs;
  }

  cachePath(): string {
    return this.account
      ? accountUsageCachePath(this.account.profileDir)
      : defaultUsageCachePath(this.userHome);
  }

  readCached(): CachedUsageSnapshot | undefined {
    return readUsageCacheFile(this.cachePath());
  }

  /**
   * Explicitly invoked only when the user clicks "刷新额度" in plugin settings.
   * Deduplicates concurrent clicks (in-flight lock) and enforces a 60s cooldown
   * so accidental rapid clicks never spawn duplicate `agy -p /usage` processes.
   */
  async refreshNow(explicitLaunch?: ProviderLaunch): Promise<RefreshUsageResult> {
    if (this.account && !isAccountSignedIn(this.account.profileDir)) {
      throw new Error(`账号「${this.account.label}」尚未登录，请先完成官方授权。`);
    }

    if (this.inFlight) {
      return await this.inFlight;
    }

    const cached = this.readCached();
    if (cached && cached.windows.length > 0 && this.cooldownMs > 0) {
      const fetchedMs = Date.parse(cached.fetchedAt);
      const elapsed = Number.isFinite(fetchedMs) ? Date.now() - fetchedMs : Infinity;
      if (elapsed >= 0 && elapsed < this.cooldownMs) {
        const cooldownRemainingSec = Math.max(
          1,
          Math.ceil((this.cooldownMs - elapsed) / 1000),
        );
        return {
          fetchedAt: cached.fetchedAt,
          report: {
            status: "available",
            observedAt: cached.fetchedAt,
            windows: cached.windows,
          },
          summary: formatSummaryText(cached.windows),
          fromCache: true,
          cooldownRemainingSec,
        };
      }
    }

    const run = this.executeRefresh(explicitLaunch).finally(() => {
      if (this.inFlight === run) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = run;
    return await run;
  }

  private async executeRefresh(
    explicitLaunch?: ProviderLaunch,
  ): Promise<RefreshUsageResult> {

    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) baseEnv[k] = v;
    }

    const rawLaunch: ProviderLaunch = explicitLaunch ??
      this.lastLaunch ?? {
        command: "agy",
        args: ["acp"],
        env: baseEnv,
      };

    const launch: ProviderLaunch = this.account
      ? {
          ...rawLaunch,
          env: buildAccountEnv(rawLaunch.env, this.account.profileDir),
        }
      : rawLaunch;

    const acpIndex = launch.args.indexOf("acp");
    const prefix = acpIndex < 0 ? launch.args : launch.args.slice(0, acpIndex);
    const commandArgs = [...prefix, "-p", "/usage", "--output-format", "json"];

    const runUsage = (env: Record<string, string>) =>
      execCommand(launch.command, commandArgs, {
        env,
        timeout: 25_000,
        maxBuffer: 1024 * 1024,
      });

    let result;
    try {
      result = this.account
        ? await withIsolatedUsageHome(launch.env, this.account.profileDir, runUsage)
        : await runUsage(launch.env);
    } catch {
      throw new Error("查询额度失败或超时，请检查 agy CLI 是否已登录且网络正常。");
    }

    const data = responseSchema.parse(JSON.parse(result.stdout));
    if (data.status !== "SUCCESS") {
      throw new Error(
        data.error || data.response || `agy usage returned ${data.status}`,
      );
    }
    if (!data.command) throw new Error("agy 未返回额度数据。");

    const groups = data.command.data.groups;
    const includeGroup = groups.length > 1;
    const windows = groups.flatMap((group) => {
      const groupLabel = formatGroupLabel(group.name);
      return group.buckets.flatMap((bucket) => {
        if (!bucket.disabled && bucket.remaining_fraction == null) return [];
        const used = bucket.disabled ? null : (1 - bucket.remaining_fraction!) * 100;
        return [
          windowFromUsedPct({
            id: bucket.id,
            label: [
              groupLabel,
              formatWindowLabel(bucket.name, bucket.window),
              bucket.disabled ? "Disabled" : null,
            ]
              .filter(Boolean)
              .join(" · "),
            shortLabel: formatShortLabel(
              includeGroup ? groupLabel : "",
              bucket.window,
            ),
            summary: !bucket.disabled && bucket.window === "weekly",
            utilizationPct: used,
            durationSeconds: windowDurationSeconds(bucket.window),
            resetsAt: bucket.disabled ? null : normalizeResetTime(bucket.reset_time),
            tone: used === null ? "default" : toneFromUsedPct(used),
          }),
        ];
      });
    });

    if (windows.length === 0) {
      throw new Error("agy 返回的额度分组为空。");
    }

    const fetchedAt = new Date().toISOString();
    writeUsageCacheFile(this.cachePath(), { fetchedAt, windows });

    return {
      fetchedAt,
      report: { status: "available", observedAt: fetchedAt, windows },
      summary: formatSummaryText(windows),
      fromCache: false,
    };
  }

  registration(): UsageSourceRegistration {
    const providerId = this.account?.providerId ?? BASE_PROVIDER_ID;
    const providerLabel = this.account?.providerLabel ?? BASE_PROVIDER_LABEL;
    return {
      id: providerId,
      label: providerLabel,
      icon: "icon.svg",
      input,
      provider: providerId,
      discover: async (scope) => {
        if (scope.kind === "session" && scope.provider !== providerId) return [];
        if (this.account && !isAccountSignedIn(this.account.profileDir)) return [];
        if (scope.launch) {
          this.lastLaunch = scope.launch;
        }
        const cachePath = this.cachePath();
        return [
          {
            key: hashAccountKey(cachePath),
            provider: providerId,
            ...(this.account ? { label: this.account.label } : {}),
            input: { cachePath },
          },
        ];
      },
      // Pure disk-cache read: never runs `agy -p /usage` on background polling.
      fetch: async (value) => {
        const { cachePath } = input.parse(value);
        if (this.account && !isAccountSignedIn(this.account.profileDir)) {
          return unavailable({
            kind: "no_quota",
            detail: `账号「${this.account.label}」尚未登录。`,
          });
        }
        const cached = readUsageCacheFile(cachePath);
        if (!cached || cached.windows.length === 0) {
          return unavailable({
            kind: "no_quota",
            detail:
              "尚未手动刷新额度。请在「设置 → 插件 → Better Paseo Antigravity」中点击「刷新额度」。",
          });
        }
        return {
          status: "available",
          observedAt: cached.fetchedAt,
          windows: cached.windows,
        };
      },
    };
  }
}
