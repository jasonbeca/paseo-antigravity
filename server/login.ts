import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import {
  APP_DATA_DIR_NAME,
  buildAccountEnv,
  isAccountSignedIn,
  prepareAccountProfile,
  type AccountProfile,
} from "./accounts";
import { stopProcessGroup } from "./process-group";

const ANTIGRAVITY_CALLBACK_URI = "https://antigravity.google/oauth-callback";
const MAX_URL_LENGTH = 16_384;

export interface LoginManagerOptions {
  command?: string;
  baseArgs?: readonly string[];
  baseEnv?: Readonly<Record<string, string | undefined>>;
  userHome?: string;
  urlTimeoutMs?: number;
  sessionTimeoutMs?: number;
  completeTimeoutMs?: number;
}

interface ActiveLogin {
  readonly child: ChildProcessWithoutNullStreams;
  readonly profileDir: string;
  readonly authUrl: string;
  readonly expiresAt: string;
  readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly timer: ReturnType<typeof setTimeout>;
  submitting: boolean;
}

/**
 * Extract an authorization code from either a raw code string or a full
 * Google/Antigravity callback URL pasted by the user.
 */
export function extractAuthorizationCode(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("授权码不能为空。");
  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error("粘贴的回调链接格式无效。");
    }
    const code = parsed.searchParams.get("code")?.trim();
    if (!code) throw new Error("回调链接中未找到 code 参数。");
    return code;
  }
  if (/\s/.test(trimmed)) {
    throw new Error("授权码不能包含空白字符。");
  }
  return trimmed;
}

/**
 * Validate and extract the official Google OAuth URL emitted by `agy acp --login`.
 */
export function parseOfficialAuthUrl(text: string): string | undefined {
  const match = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+/.exec(text);
  if (!match) return undefined;
  const candidate = match[0].replace(/[),.;]+$/, "");
  if (candidate.length > MAX_URL_LENGTH) return undefined;
  try {
    const parsed = new URL(candidate);
    if (
      parsed.origin !== "https://accounts.google.com" ||
      parsed.pathname !== "/o/oauth2/auth" ||
      parsed.searchParams.get("response_type") !== "code" ||
      parsed.searchParams.get("redirect_uri") !== ANTIGRAVITY_CALLBACK_URI
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export class AccountLoginManager {
  private readonly active = new Map<string, ActiveLogin>();
  private readonly options: LoginManagerOptions;

  constructor(options: LoginManagerOptions = {}) {
    this.options = options;
  }

  getState(accountId: string): { loginInProgress: boolean; authUrl?: string } {
    const session = this.active.get(accountId);
    if (!session) return { loginInProgress: false };
    return { loginInProgress: true, authUrl: session.authUrl };
  }

  async start(
    account: AccountProfile,
  ): Promise<{ authUrl: string; expiresAt: string }> {
    if (process.platform === "win32") {
      throw new Error("当前登录进程管理实现仅支持 macOS / Linux。");
    }
    await this.cancel(account.id);
    prepareAccountProfile(account.profileDir, this.options.userHome);

    const command = this.options.command ?? "agy";
    const baseArgs = this.options.baseArgs ?? [];
    const args = [
      ...baseArgs,
      "acp",
      "--gemini-dir",
      path.resolve(account.profileDir),
      "--app-data-dir",
      APP_DATA_DIR_NAME,
      "--login",
    ];

    const env = buildAccountEnv(
      this.options.baseEnv ?? process.env,
      account.profileDir,
    );
    // Suppress automatic browser launch on the daemon host so agy prints the URL cleanly.
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    env.BROWSER = "true";

    const child = spawn(command, args, {
      env,
      shell: false,
      detached: true,
      stdio: "pipe",
    });

    const exitPromise = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", () => resolve({ code: -1, signal: null }));
    });

    const urlTimeoutMs = this.options.urlTimeoutMs ?? 20_000;
    let buffer = "";

    const authUrl = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        child.off("error", onError);
        child.off("exit", onEarlyExit);
        fn();
      };
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 64_000) buffer = buffer.slice(-32_000);
        const url = parseOfficialAuthUrl(buffer);
        if (url) done(() => resolve(url));
      };
      const onError = (err: Error) => {
        done(() =>
          reject(
            new Error(
              `无法启动官方 agy 登录进程：${err.message || "请检查 agy 是否已安装。"}`,
            ),
          ),
        );
      };
      const onEarlyExit = (code: number | null) => {
        done(() =>
          reject(
            new Error(
              code === 0
                ? "该账号已完成登录或无需重新授权。"
                : `agy 登录进程提前退出（退出码 ${code ?? "未知"}）。`,
            ),
          ),
        );
      };
      const timer = setTimeout(() => {
        done(() => reject(new Error("等待官方 agy 输出登录链接超时。")));
      }, urlTimeoutMs);
      timer.unref();

      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("error", onError);
      child.once("exit", onEarlyExit);
    }).catch(async (error) => {
      await stopProcessGroup(child.pid).catch(() => {});
      throw error;
    });

    // Drain remaining output so the child never blocks on a full pipe.
    child.stdout.resume();
    child.stderr.resume();

    const sessionTimeoutMs = this.options.sessionTimeoutMs ?? 180_000;
    const expiresAt = new Date(Date.now() + sessionTimeoutMs).toISOString();
    const timer = setTimeout(() => {
      void this.cancel(account.id);
    }, sessionTimeoutMs);
    timer.unref();

    const session: ActiveLogin = {
      child,
      profileDir: account.profileDir,
      authUrl,
      expiresAt,
      exitPromise,
      timer,
      submitting: false,
    };
    this.active.set(account.id, session);

    void exitPromise.then(() => {
      if (this.active.get(account.id) === session) {
        clearTimeout(session.timer);
        this.active.delete(account.id);
      }
    });

    return { authUrl, expiresAt };
  }

  async submitCode(accountId: string, rawInput: string): Promise<boolean> {
    const session = this.active.get(accountId);
    if (!session) {
      throw new Error("没有正在进行的登录会话，请先点击“登录”。");
    }
    if (session.submitting) {
      throw new Error("正在提交授权码，请稍候。");
    }
    const code = extractAuthorizationCode(rawInput);
    session.submitting = true;
    const completeTimeoutMs = this.options.completeTimeoutMs ?? 30_000;

    try {
      await new Promise<void>((resolve, reject) => {
        session.child.stdin.write(`${code}\n`, (err) => {
          if (err) reject(new Error("向 agy 登录进程写入授权码失败。"));
          else {
            session.child.stdin.end();
            resolve();
          }
        });
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        session.exitPromise,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), completeTimeoutMs);
          timer.unref();
        }),
      ]).finally(() => clearTimeout(timer));

      if (result === "timeout") {
        throw new Error("验证授权码超时，请重新发起登录。");
      }
      if (result.code !== 0) {
        throw new Error(
          `官方 agy 登录未成功（退出码 ${result.code ?? "未知"}）。请检查授权码是否过期后重试。`,
        );
      }
      if (!isAccountSignedIn(session.profileDir)) {
        throw new Error("登录进程已退出，但未检测到凭据文件。请重试。");
      }
      return true;
    } finally {
      clearTimeout(session.timer);
      if (this.active.get(accountId) === session) {
        this.active.delete(accountId);
      }
      await stopProcessGroup(session.child.pid).catch(() => {});
    }
  }

  async cancel(accountId: string): Promise<boolean> {
    const session = this.active.get(accountId);
    if (!session) return false;
    clearTimeout(session.timer);
    this.active.delete(accountId);
    try {
      session.child.stdin.destroy();
    } catch {
      /* ignore */
    }
    await stopProcessGroup(session.child.pid).catch(() => {});
    return true;
  }

  async cancelAll(): Promise<void> {
    await Promise.allSettled([...this.active.keys()].map((id) => this.cancel(id)));
  }
}
