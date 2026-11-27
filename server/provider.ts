import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import path from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type {
  ProviderRegistration,
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderLaunch,
} from "@getpaseo/plugin/server/provider";
import { BASE_PROVIDER_ID, BASE_PROVIDER_LABEL } from "../shared/accounts";
import {
  APP_DATA_DIR_NAME,
  accountAcpCommand,
  buildAccountEnv,
  isAccountSignedIn,
  prepareAccountProfile,
  type AccountProfile,
} from "./accounts";
import {
  createTransport,
  type Context,
  type OwnedTransport,
} from "./transport";
import { vendor, options } from "./vendor";
import { defaults, type Limits } from "./watch";

function applyAccountLaunch(
  launch: ProviderLaunch,
  account: AccountProfile | undefined,
  userHome?: string,
): ProviderLaunch {
  if (!account) return launch;
  prepareAccountProfile(account.profileDir, userHome);
  const resolvedProfile = path.resolve(account.profileDir);
  const args = [...launch.args];
  const acpIndex = args.indexOf("acp");
  if (acpIndex >= 0 && !args.includes("--gemini-dir") && !args.includes("--gemini_dir")) {
    args.splice(
      acpIndex + 1,
      0,
      "--gemini-dir",
      resolvedProfile,
      "--app-data-dir",
      APP_DATA_DIR_NAME,
    );
  }
  return {
    ...launch,
    args,
    env: buildAccountEnv(launch.env, resolvedProfile),
  };
}

export function provider(
  testOptions: {
    limits?: Limits;
    closeTimeoutMs?: number;
    statusTimeoutMs?: number;
    account?: AccountProfile;
    userHome?: string;
  } = {},
): ProviderRegistration {
  const account = testOptions.account;
  const providerId = account?.providerId ?? BASE_PROVIDER_ID;
  const providerLabel = account?.providerLabel ?? BASE_PROVIDER_LABEL;
  return {
    id: providerId,
    label: providerLabel,
    icon: "icon.svg",
    description: account
      ? `独立账号（${account.label}）；使用官方 agy acp 与独立 GEMINI_HOME，不修改系统 Keychain 或 HOME。`
      : "复用官方 CLI 登录和配置；会话进度提示与可控取消。",
    command: account
      ? accountAcpCommand(account.profileDir)
      : ["agy", "acp", "--disable-telemetry"],
    catalogRefresh: "on_demand",
    docsUrl: "https://paseo.sh/docs/supported-providers/antigravity",
    ...(account
      ? {
          async getCatalogCacheKey() {
            const signedIn = isAccountSignedIn(account.profileDir) ? "signed-in" : "signed-out";
            return `${providerId}:${path.resolve(account.profileDir)}:${signedIn}`;
          },
        }
      : {}),
    installation: {
      installUrl: "https://antigravity.google/docs/getting-started?tab=cli",
      async inspect({ launch, signal }) {
        if (!launch?.resolved) return { status: "not_installed" };
        const effectiveEnv = account
          ? buildAccountEnv(launch.env, account.profileDir)
          : launch.env;
        const prefix = launch.args.indexOf("acp");
        const { stdout } = await execCommand(
          launch.command,
          [
            ...(prefix < 0 ? launch.args : launch.args.slice(0, prefix)),
            "--version",
          ],
          { env: effectiveEnv, signal, timeout: 10000, maxBuffer: 8192 },
        );
        return {
          status: "installed",
          version: /\b\d+\.\d+\.\d+\b/.exec(stdout)?.[0],
        };
      },
    },
    async status({ launch: rawLaunch }) {
      if (!rawLaunch)
        return { available: false, diagnostic: "未找到官方 agy CLI。" };
      if (account && !isAccountSignedIn(account.profileDir)) {
        return {
          available: false,
          diagnostic: `账号「${account.label}」尚未登录。请在「设置 → 插件 → Better Paseo Antigravity」中完成官方授权。`,
        };
      }
      const launch = applyAccountLaunch(rawLaunch, account, testOptions.userHome);
      const ssh = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"].find(
        (key) => launch.env[key],
      );
      const signIn = account
        ? `独立账号配置：${account.label}（GEMINI_HOME 隔离文件存储）`
        : ssh
          ? `SSH 环境（${ssh}）：CLI 的登录来源可能与本机终端不同。`
          : "非 SSH 环境：沿用 CLI 原有登录来源。";
      const deadline =
        Date.now() +
        (testOptions.statusTimeoutMs ?? options.startupTimeoutMs ?? 95000);
      const remaining = () => Math.max(1, deadline - Date.now());
      let phase = "CLI 版本检查";
      let safeFailure: string | undefined;
      try {
        const prefix = launch.args.indexOf("acp");
        if (prefix < 0)
          return { available: false, diagnostic: "启动参数必须包含 acp。" };
        const { stdout } = await execCommand(
          launch.command,
          [...launch.args.slice(0, prefix), "--version"],
          { env: launch.env, timeout: remaining(), maxBuffer: 8192 },
        );
        const version = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(stdout);
        if (
          !version ||
          Number(version[1]) < 1 ||
          (Number(version[1]) === 1 && Number(version[2]) < 5)
        )
          return {
            available: false,
            diagnostic: "需要官方 agy 1.5 或更新版本。",
          };
        phase = "ACP 握手";
        const probes = new Set<OwnedTransport>();
        try {
          const probe = runAcpProvider({
            id: providerId,
            label: providerLabel,
            acpOptions: { startupTimeoutMs: remaining() },
            connector: () => {
              const t = createTransport(
                launch,
                { cwd: homedir(), env: {} },
                () => {},
                {
                  ...defaults,
                  startup: Math.min(defaults.startup, remaining()),
                },
                (message) => {
                  safeFailure ??= message;
                },
              );
              probes.add(t);
              return t.stream;
            },
          });
          const connection = await probe.connect({
            launch,
            versions: [1],
            capabilities: [],
          });
          await connection.close();
        } finally {
          await Promise.allSettled([...probes].map((t) => t.close()));
        }
        return {
          available: true,
          diagnostic: `CLI ${version[0]} 与 ACP 握手正常。账号及模型访问仍由创建会话验证。\n${signIn}`,
        };
      } catch {
        return {
          available: false,
          // Only our fixed transport diagnostics are safe to show. Never echo raw
          // exec/SDK errors, which can contain command output or an authorization URL.
          diagnostic: `${safeFailure ?? `${phase}失败或超过启动时限。请检查可执行文件、acp 参数与登录环境。`}\n${signIn}`,
        };
      }
    },
    async connect(request): Promise<ProviderConnection> {
      if (!request.launch) throw new Error("缺少官方 CLI 启动配置。");
      const launch = applyAccountLaunch(request.launch, account, testOptions.userHome);
      const scope = new AsyncLocalStorage<Context>();
      const owned = new Set<OwnedTransport>();
      const listeners = new Set<(e: ProviderEvent) => void>();
      const transports = new Map<string, OwnedTransport>();
      const failures = new Map<string, string>();
      let closed = false;
      let connectionClosing: Promise<void> | undefined;
      const emit = (e: ProviderEvent) => {
        if (!closed) for (const l of listeners) l(e);
      };
      const shim = runAcpProvider({
        id: providerId,
        label: providerLabel,
        acpOptions: options,
        transformers: [vendor],
        connector: () => {
          if (closed) throw new Error("Provider 已关闭。");
          const context = scope.getStore() ?? { cwd: homedir(), env: {} };
          if (context.sessionId) failures.delete(context.sessionId);
          const transport = createTransport(
            launch,
            context,
            (message) => {
              if (context.sessionId) {
                emit({
                  type: "session.notice",
                  sessionId: context.sessionId,
                  notice: {
                    id: "antigravity-progress",
                    severity: "warning",
                    title: message,
                  },
                });
              }
            },
            testOptions.limits,
            (message) => {
              if (context.sessionId && !failures.has(context.sessionId))
                failures.set(context.sessionId, message);
            },
          );
          if (context.sessionId) transports.set(context.sessionId, transport);
          owned.add(transport);
          void transport.finished.then(() => owned.delete(transport));
          return transport.stream;
        },
      });
      let core: ProviderConnection;
      try {
        core = await shim.connect(request);
      } catch (e) {
        await Promise.allSettled([...owned].map((t) => t.close()));
        throw e;
      }
      const hasText = new Map<string, boolean>();
      const off = core.onEvent((e) => {
        if (
          e.type === "session.runtime_failed" ||
          (e.type === "session.turn" && e.state === "failed")
        ) {
          const reason = failures.get(e.sessionId);
          if (
            reason &&
            [
              "ACP transport closed unexpectedly",
              "Connection closed",
              "ACP connection closed",
              "ACP turn failed",
            ].includes(e.error?.message ?? "")
          )
            e = { ...e, error: { ...e.error, message: reason } };
        }
        if (e.type === "session.closed" || e.type === "session.runtime_failed")
          hasText.delete(e.sessionId);
        if (e.type === "session.closed") {
          transports.delete(e.sessionId);
          failures.delete(e.sessionId);
        }
        if (e.type === "session.turn" && e.state === "started")
          hasText.set(e.sessionId, false);
        if (
          e.type === "timeline.item" &&
          e.item.type === "assistant_message" &&
          e.item.text.trim()
        )
          hasText.set(e.sessionId, true);
        if (
          e.type === "session.turn" &&
          e.state === "completed" &&
          hasText.get(e.sessionId) === false
        )
          emit({
            type: "session.notice",
            sessionId: e.sessionId,
            notice: {
              id: "antigravity-empty",
              severity: "warning",
              title:
                "本轮已结束，但没有返回正文。请检查工具结果或官方 CLI 的错误提示；消息没有自动重发。",
            },
          });
        if (e.type === "session.turn" && e.state !== "started") {
          hasText.delete(e.sessionId);
          // Completion of a foreground turn does not imply its background tools ended.
        }
        if (
          e.type === "timeline.item" &&
          e.item.type === "tool_call" &&
          ["completed", "failed", "canceled"].includes(e.item.status)
        ) {
          transports.get(e.sessionId)?.finishTool(e.item.callId);
        }
        emit(e);
      });
      return {
        version: core.version,
        capabilities: core.capabilities,
        onEvent(l) {
          listeners.add(l);
          return () => {
            listeners.delete(l);
          };
        },
        send(input: ProviderInput) {
          if (closed) return Promise.reject(new Error("Provider 已关闭。"));
          const context: Context =
            input.type === "session.open"
              ? {
                  cwd: input.config.cwd,
                  env: input.config.env,
                  sessionId: input.sessionId,
                }
              : {
                  cwd: "cwd" in input && input.cwd ? input.cwd : homedir(),
                  env: {},
                };
          return scope.run(context, () => core.send(input));
        },
        close() {
          return (connectionClosing ??= (async () => {
            closed = true;
            off();
            listeners.clear();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const graceful = core.close();
            try {
              await Promise.race([
                graceful,
                new Promise<void>((resolve) => {
                  timer = setTimeout(
                    resolve,
                    testOptions.closeTimeoutMs ?? 5000,
                  );
                  timer.unref();
                }),
              ]);
            } catch {
              /* force cleanup also runs when graceful close fails */
            } finally {
              clearTimeout(timer);
              await Promise.allSettled([...owned].map((t) => t.close()));
              owned.clear();
              transports.clear();
              failures.clear();
              hasText.clear();
            }
            // Do not wait indefinitely for an SDK operation stuck outside the transport.
            void graceful.catch(() => {});
          })());
        },
      };
    },
  };
}
