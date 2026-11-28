import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
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
  STATUSLINE_USAGE_FILENAME,
  accountStatuslineUsagePath,
  isAccountSignedIn,
  type AccountProfile,
} from "./accounts";

const inputSchema = z.object({ filePath: z.string().min(1) }).strict();

interface RawQuotaBucket {
  readonly id?: string;
  readonly name?: string;
  readonly label?: string;
  readonly window?: string;
  readonly remaining_fraction?: number | null;
  readonly remaining_percentage?: number | null;
  readonly used_percentage?: number | null;
  readonly reset_in_seconds?: number | null;
  readonly reset_time?: string | null;
  readonly resets_at?: string | number | null;
  readonly disabled?: boolean;
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function normalizeTimestamp(
  value: string | number | null | undefined,
): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Support both epoch seconds and epoch milliseconds.
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > 0) {
      return new Date(ms).toISOString();
    }
  }
  return null;
}

function resolveResetTime(
  bucket: RawQuotaBucket,
  capturedAtMs: number,
): string | null {
  const direct =
    normalizeTimestamp(bucket.reset_time) ??
    normalizeTimestamp(bucket.resets_at);
  if (direct) return direct;
  if (
    typeof bucket.reset_in_seconds === "number" &&
    Number.isFinite(bucket.reset_in_seconds) &&
    bucket.reset_in_seconds > 0
  ) {
    return new Date(capturedAtMs + bucket.reset_in_seconds * 1000).toISOString();
  }
  return null;
}

function resolveUsedPct(bucket: RawQuotaBucket): number | null {
  if (bucket.disabled) return null;
  if (
    typeof bucket.used_percentage === "number" &&
    Number.isFinite(bucket.used_percentage)
  ) {
    return clampPct(bucket.used_percentage);
  }
  if (
    typeof bucket.remaining_fraction === "number" &&
    Number.isFinite(bucket.remaining_fraction)
  ) {
    return clampPct((1 - bucket.remaining_fraction) * 100);
  }
  if (
    typeof bucket.remaining_percentage === "number" &&
    Number.isFinite(bucket.remaining_percentage)
  ) {
    return clampPct(100 - bucket.remaining_percentage);
  }
  return null;
}

function classifyWindow(key: string, bucket: RawQuotaBucket): {
  id: string;
  label: string;
  shortLabel: string;
  durationSeconds?: number;
  summary: boolean;
} {
  const id = (bucket.id || key).trim() || "quota";
  const normalized = `${id} ${bucket.window ?? ""} ${bucket.name ?? ""}`.toLowerCase();

  if (
    normalized.includes("5h") ||
    normalized.includes("five_hour") ||
    normalized.includes("five hour") ||
    normalized.includes("session")
  ) {
    const prefix = extractGroupPrefix(id);
    return {
      id,
      label: bucket.label || (prefix ? `${prefix} · 5h` : "5h"),
      shortLabel: prefix ? `${prefix} 5h` : "5h",
      durationSeconds: 5 * 3600,
      summary: false,
    };
  }

  if (
    normalized.includes("weekly") ||
    normalized.includes("week") ||
    normalized.includes("7d") ||
    normalized.includes("seven_day")
  ) {
    const prefix = extractGroupPrefix(id);
    return {
      id,
      label: bucket.label || (prefix ? `${prefix} · Weekly` : "Weekly"),
      shortLabel: prefix ? `${prefix} wk` : "wk",
      durationSeconds: 7 * 86400,
      summary: true,
    };
  }

  const cleanLabel =
    bucket.label ||
    bucket.name?.trim().replace(/(?:\s+Limit)?\s+Remaining$/i, "") ||
    id;
  return {
    id,
    label: cleanLabel,
    shortLabel: bucket.window?.trim() || cleanLabel.slice(0, 8),
    summary: false,
  };
}

function extractGroupPrefix(id: string): string {
  const stripped = id
    .replace(/[-_](?:5h|five_hour|weekly|7d|seven_day)$/i, "")
    .trim();
  if (!stripped || stripped.toLowerCase() === id.toLowerCase()) return "";
  if (stripped.toLowerCase() === "gemini") return "Gemini";
  if (stripped.toLowerCase() === "3p") return "Claude/GPT";
  return stripped;
}

function asBucket(value: unknown): RawQuotaBucket | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as RawQuotaBucket;
}

/**
 * Parse a statusLine JSON snapshot captured during an interactive `agy` session.
 * Pure local parsing — never spawns `agy` or performs any network request.
 */
export function parseStatusLineUsageSnapshot(
  rawJson: unknown,
  fallbackObservedAt: Date,
): UsageReport {
  if (!rawJson || typeof rawJson !== "object" || Array.isArray(rawJson)) {
    return unavailable({
      kind: "no_quota",
      detail: "statusline-usage.json 格式无效。",
    });
  }

  const root = rawJson as Record<string, unknown>;
  const observedAt =
    normalizeTimestamp(
      typeof root.captured_at === "string" || typeof root.captured_at === "number"
        ? root.captured_at
        : undefined,
    ) ?? fallbackObservedAt.toISOString();
  const capturedAtMs = Date.parse(observedAt);

  const payload =
    root.data && typeof root.data === "object" && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : root;

  const windows: UsageWindow[] = [];

  // 1. Antigravity native statusLine `quota` map
  if (
    payload.quota &&
    typeof payload.quota === "object" &&
    !Array.isArray(payload.quota)
  ) {
    for (const [key, value] of Object.entries(
      payload.quota as Record<string, unknown>,
    )) {
      const bucket = asBucket(value);
      if (!bucket) continue;
      const usedPct = resolveUsedPct(bucket);
      if (!bucket.disabled && usedPct === null) continue;
      const meta = classifyWindow(key, bucket);
      windows.push(
        windowFromUsedPct({
          id: meta.id,
          label: bucket.disabled ? `${meta.label} · Disabled` : meta.label,
          shortLabel: meta.shortLabel,
          summary: !bucket.disabled && meta.summary,
          utilizationPct: usedPct,
          durationSeconds: meta.durationSeconds,
          resetsAt: bucket.disabled ? null : resolveResetTime(bucket, capturedAtMs),
          tone: usedPct === null ? "default" : toneFromUsedPct(usedPct),
        }),
      );
    }
  }

  // 2. Fallback: `rate_limits` (five_hour / seven_day)
  if (
    windows.length === 0 &&
    payload.rate_limits &&
    typeof payload.rate_limits === "object" &&
    !Array.isArray(payload.rate_limits)
  ) {
    for (const [key, value] of Object.entries(
      payload.rate_limits as Record<string, unknown>,
    )) {
      const bucket = asBucket(value);
      if (!bucket) continue;
      const usedPct = resolveUsedPct(bucket);
      if (!bucket.disabled && usedPct === null) continue;
      const meta = classifyWindow(key, bucket);
      windows.push(
        windowFromUsedPct({
          id: meta.id,
          label: meta.label,
          shortLabel: meta.shortLabel,
          summary: !bucket.disabled && meta.summary,
          utilizationPct: usedPct,
          durationSeconds: meta.durationSeconds,
          resetsAt: resolveResetTime(bucket, capturedAtMs),
          tone: usedPct === null ? "default" : toneFromUsedPct(usedPct),
        }),
      );
    }
  }

  if (windows.length === 0) {
    return unavailable({
      kind: "no_quota",
      detail: "statusline-usage.json 中未包含有效的配额字段。",
    });
  }

  // Ensure at least one summary window is selected for compact views.
  if (!windows.some((w) => w.summary)) {
    const firstActive = windows.find((w) => w.usedPct !== null);
    if (firstActive) firstActive.summary = true;
  }

  return {
    status: "available",
    observedAt,
    windows,
  };
}

export class Usage {
  private readonly account?: AccountProfile;
  private readonly userHome: string;

  constructor(account?: AccountProfile, userHome = homedir()) {
    this.account = account;
    this.userHome = userHome;
  }

  private resolveSnapshotPath(env?: Readonly<Record<string, string>>): string {
    if (this.account) {
      return accountStatuslineUsagePath(this.account.profileDir);
    }
    const baseDir = env?.GEMINI_HOME
      ? path.resolve(env.GEMINI_HOME)
      : path.join(env?.HOME ?? this.userHome, ".gemini");
    return path.join(baseDir, APP_DATA_DIR_NAME, STATUSLINE_USAGE_FILENAME);
  }

  registration(): UsageSourceRegistration {
    const providerId = this.account?.providerId ?? BASE_PROVIDER_ID;
    const providerLabel = this.account?.providerLabel ?? BASE_PROVIDER_LABEL;
    return {
      id: providerId,
      label: providerLabel,
      icon: "icon.svg",
      input: inputSchema,
      provider: providerId,
      discover: async (scope) => {
        if (scope.kind === "session" && scope.provider !== providerId) {
          return [];
        }
        if (this.account && !isAccountSignedIn(this.account.profileDir)) {
          return [];
        }
        const filePath = this.resolveSnapshotPath(scope.launch?.env);
        return [
          {
            key: hashAccountKey(filePath),
            provider: providerId,
            ...(this.account ? { label: this.account.label } : {}),
            input: { filePath },
          },
        ];
      },
      fetch: async (value) => {
        const { filePath } = inputSchema.parse(value);
        let raw: string;
        let mtime: Date;
        try {
          const stat = statSync(filePath);
          mtime = stat.mtime;
          raw = readFileSync(filePath, "utf8");
        } catch {
          const hint = this.account
            ? `尚未检测到本地额度快照。请在终端运行 agy-acc ${this.account.id} 打开交互界面后自动写入。`
            : "尚未检测到本地额度快照。请在终端运行交互式 agy 后自动写入。";
          return unavailable({ kind: "no_quota", detail: hint });
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return unavailable({
            kind: "no_quota",
            detail: "本地 statusline-usage.json 解析失败。",
          });
        }
        return parseStatusLineUsageSnapshot(parsed, mtime);
      },
    };
  }
}
