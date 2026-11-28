import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  TextInput,
  copyText,
  useToast,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  addAccountRpc,
  cancelAccountLoginRpc,
  listAccountsRpc,
  logoutAccountRpc,
  refreshAccountUsageRpc,
  removeAccountRpc,
  startAccountLoginRpc,
  submitAccountLoginCodeRpc,
  type AccountSummary,
} from "../shared/accounts";

function slugifyId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function AccountsSettings({ theme, layout }: PluginSurfaceProps) {
  const toast = useToast();
  const listAccounts = useRpc(listAccountsRpc);
  const addAccount = useRpc(addAccountRpc);
  const removeAccount = useRpc(removeAccountRpc);
  const logoutAccount = useRpc(logoutAccountRpc);
  const startLogin = useRpc(startAccountLoginRpc);
  const submitCode = useRpc(submitAccountLoginCodeRpc);
  const cancelLogin = useRpc(cancelAccountLoginRpc);
  const refreshUsage = useRpc(refreshAccountUsageRpc);

  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [needsReload, setNeedsReload] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [newLabel, setNewLabel] = useState("");
  const [newId, setNewId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const labelRef = useRef<SettingsInputHandle>(null);
  const idRef = useRef<SettingsInputHandle>(null);

  const [codeDrafts, setCodeDrafts] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await listAccounts({});
      setAccounts(data.accounts);
      setNeedsReload(data.needsReload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载账号列表失败。");
    } finally {
      setLoading(false);
    }
  }, [listAccounts]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const styles = useMemo(
    () => ({
      root: {
        gap: layout.compact ? 14 : 18,
      },
      banner: {
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.statusWarning,
        backgroundColor: theme.colors.surface1,
        gap: 6,
      },
      bannerTitle: {
        color: theme.colors.statusWarning,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      bannerBody: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
      },
      errorBox: {
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        backgroundColor: theme.colors.surface1,
      },
      errorText: {
        color: theme.colors.statusDanger,
        fontSize: 13,
      },
      statusRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      badge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        borderWidth: 1,
      },
      badgeText: {
        fontSize: 12,
        fontWeight: "600" as const,
      },
      actionsRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 8,
        marginTop: 8,
      },
      button: {
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      primaryButton: {
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      dangerButton: {
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        backgroundColor: theme.colors.surface1,
      },
      buttonText: {
        color: theme.colors.foreground,
        fontSize: 13,
        fontWeight: "500" as const,
      },
      primaryButtonText: {
        color: theme.colors.accentForeground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      dangerButtonText: {
        color: theme.colors.statusDanger,
        fontSize: 13,
        fontWeight: "500" as const,
      },
      loginBox: {
        marginTop: 10,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
        gap: 8,
      },
      muted: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
      },
      codeInput: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 13,
      },
    }),
    [theme, layout.compact],
  );

  const handleAdd = async () => {
    const label = newLabel.trim();
    const id = (idTouched ? newId : slugifyId(label)).trim();
    if (!label || !id) {
      toast.error("请填写账号名称和有效的账号 ID（小写字母/数字/连字符）。");
      return;
    }
    setBusyId("__add__");
    try {
      const result = await addAccount({ id, label });
      setNewLabel("");
      setNewId("");
      setIdTouched(false);
      labelRef.current?.replaceText("");
      idRef.current?.replaceText("");
      toast.show(`已添加账号「${result.account.label}」`, { variant: "success" });
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "添加账号失败。");
    } finally {
      setBusyId(null);
    }
  };

  const handleStartLogin = async (account: AccountSummary) => {
    setBusyId(account.id);
    try {
      const result = await startLogin({ id: account.id });
      await refresh();
      try {
        await openExternalUrl(result.authUrl);
        toast.show("已打开 Google 登录页，请复制页面显示的授权码并粘贴到下方。", {
          variant: "info",
        });
      } catch {
        toast.show("已生成登录链接，请点击“打开登录链接”或复制链接。", {
          variant: "info",
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "启动登录失败。");
    } finally {
      setBusyId(null);
    }
  };

  const handleSubmitCode = async (account: AccountSummary) => {
    const code = (codeDrafts[account.id] ?? "").trim();
    if (!code) {
      toast.error("请先粘贴 Google 授权码或回调页面完整链接。");
      return;
    }
    setBusyId(account.id);
    try {
      await submitCode({ id: account.id, code });
      setCodeDrafts((prev) => {
        const next = { ...prev };
        delete next[account.id];
        return next;
      });
      toast.show(`账号「${account.label}」登录成功`, { variant: "success" });
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "授权码验证失败。");
    } finally {
      setBusyId(null);
    }
  };

  const handleCancelLogin = async (account: AccountSummary) => {
    setBusyId(account.id);
    try {
      await cancelLogin({ id: account.id });
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "取消登录失败。");
    } finally {
      setBusyId(null);
    }
  };

  const handleLogout = async (account: AccountSummary) => {
    setBusyId(account.id);
    try {
      await logoutAccount({ id: account.id });
      toast.show(`账号「${account.label}」已退出登录`, { variant: "info" });
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "退出登录失败。");
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async (account: AccountSummary) => {
    setBusyId(account.id);
    try {
      await removeAccount({ id: account.id, deleteProfile: false });
      toast.show(`已移除账号「${account.label}」（已保留历史目录）`, {
        variant: "info",
      });
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "移除账号失败。");
    } finally {
      setBusyId(null);
    }
  };

  const handleRefreshUsage = async (id: string, label: string) => {
    setBusyId(`usage:${id}`);
    try {
      const result = await refreshUsage({ id });
      if (result.fromCache) {
        toast.show(
          `「${label}」60 秒冷却中，已复用缓存（${result.summary}，约 ${result.cooldownRemainingSec ?? 1}s 后可重刷）`,
          { variant: "info" },
        );
      } else {
        toast.show(`已刷新「${label}」额度：${result.summary}`, {
          variant: "success",
        });
      }
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `刷新「${label}」额度失败。`);
    } finally {
      setBusyId(null);
    }
  };

  const handleRefreshAllUsage = async () => {
    const targets: Array<{ id: string; label: string }> = [
      { id: "default", label: "默认账号" },
      ...accounts
        .filter((account) => account.signedIn)
        .map((account) => ({ id: account.id, label: account.label })),
    ];
    setBusyId("usage:__all__");
    let okCount = 0;
    let cachedCount = 0;
    let failCount = 0;
    try {
      // Refresh sequentially to avoid spawning multiple agy processes at once.
      for (const target of targets) {
        try {
          const result = await refreshUsage({ id: target.id });
          if (result.fromCache) cachedCount += 1;
          else okCount += 1;
        } catch {
          failCount += 1;
        }
      }
      const parts = [
        okCount > 0 ? `刷新 ${okCount} 个` : null,
        cachedCount > 0 ? `冷却复用 ${cachedCount} 个` : null,
        failCount > 0 ? `失败 ${failCount} 个` : null,
      ].filter(Boolean);
      toast.show(
        `批量刷新完成（${parts.join("，")}）。请到 Usage 面板点击 ↻ 查看最新进度条。`,
        { variant: failCount > 0 ? "info" : "success" },
      );
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <View style={styles.root}>
      {needsReload ? (
        <View style={styles.banner}>
          <Text style={styles.bannerTitle}>需要重载插件以更新 Provider 列表</Text>
          <Text style={styles.bannerBody}>
            新增或移除账号后，请在插件列表中点击重载，或在终端运行：paseo plugin reload
            better-paseo-antigravity
          </Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <SettingsSection title="独立账号实例">
        <SettingsCard>
          <SettingsRow
            label="默认账号（Better Paseo Antigravity）"
            hint="始终沿用本机原有 agy CLI 登录，不受下方独立账号影响。额度仅在手动点击刷新时查询。"
          >
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.badge,
                  { borderColor: theme.colors.border, backgroundColor: theme.colors.surface2 },
                ]}
              >
                <Text style={[styles.badgeText, { color: theme.colors.foregroundMuted }]}>
                  内置默认
                </Text>
              </View>
            </View>
            <View style={styles.actionsRow}>
              <Pressable
                accessibilityRole="button"
                disabled={busyId !== null}
                onPress={() => void handleRefreshUsage("default", "默认账号")}
                style={styles.button}
              >
                <Text style={styles.buttonText}>
                  {busyId === "usage:default" ? "刷新中..." : "刷新额度"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busyId !== null}
                onPress={() => void handleRefreshAllUsage()}
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>
                  {busyId === "usage:__all__" ? "逐个刷新中..." : "刷新全部已登录账号"}
                </Text>
              </Pressable>
            </View>
          </SettingsRow>

          {loading ? (
            <SettingsRow label="正在加载账号..." />
          ) : accounts.length === 0 ? (
            <SettingsRow
              label="尚未添加独立账号"
              hint="添加后每个账号拥有独立 GEMINI_HOME 凭据目录，可同时并发运行，不修改系统 Keychain。"
            />
          ) : (
            accounts.map((account) => {
              const isBusy = busyId === account.id;
              return (
                <SettingsRow
                  key={account.id}
                  label={`${account.label}  (${account.providerId})`}
                  hint={`目录：${account.profileDir}`}
                >
                  <View style={styles.statusRow}>
                    <View
                      style={[
                        styles.badge,
                        {
                          borderColor: account.signedIn
                            ? theme.colors.statusSuccess
                            : theme.colors.statusWarning,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.badgeText,
                          {
                            color: account.signedIn
                              ? theme.colors.statusSuccess
                              : theme.colors.statusWarning,
                          },
                        ]}
                      >
                        {account.signedIn ? "已登录" : "未登录"}
                      </Text>
                    </View>
                    {!account.activeInRuntime ? (
                      <View
                        style={[
                          styles.badge,
                          { borderColor: theme.colors.statusWarning },
                        ]}
                      >
                        <Text
                          style={[
                            styles.badgeText,
                            { color: theme.colors.statusWarning },
                          ]}
                        >
                          待重载生效
                        </Text>
                      </View>
                    ) : null}
                  </View>

                  <View style={styles.actionsRow}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={isBusy}
                      onPress={() => void handleStartLogin(account)}
                      style={styles.primaryButton}
                    >
                      <Text style={styles.primaryButtonText}>
                        {account.loginInProgress
                          ? "重新生成链接"
                          : account.signedIn
                            ? "重新登录"
                            : "官方登录"}
                      </Text>
                    </Pressable>

                    {account.signedIn ? (
                      <>
                        <Pressable
                          accessibilityRole="button"
                          disabled={busyId !== null}
                          onPress={() => void handleRefreshUsage(account.id, account.label)}
                          style={styles.button}
                        >
                          <Text style={styles.buttonText}>
                            {busyId === `usage:${account.id}` ? "刷新中..." : "刷新额度"}
                          </Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          disabled={isBusy}
                          onPress={() => void handleLogout(account)}
                          style={styles.button}
                        >
                          <Text style={styles.buttonText}>退出登录</Text>
                        </Pressable>
                      </>
                    ) : null}

                    <Pressable
                      accessibilityRole="button"
                      disabled={isBusy}
                      onPress={() => void handleRemove(account)}
                      style={styles.dangerButton}
                    >
                      <Text style={styles.dangerButtonText}>移除账号</Text>
                    </Pressable>
                  </View>

                  {account.loginInProgress && account.authUrl ? (
                    <View style={styles.loginBox}>
                      <Text style={styles.muted}>
                        1. 打开官方 Google 授权链接完成登录，复制页面显示的授权码（或整段回调 URL）。
                      </Text>
                      <View style={styles.actionsRow}>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => void openExternalUrl(account.authUrl!)}
                          style={styles.button}
                        >
                          <Text style={styles.buttonText}>打开登录链接</Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() =>
                            void copyText(account.authUrl!).then(() =>
                              toast.show("已复制登录链接", { variant: "info" }),
                            )
                          }
                          style={styles.button}
                        >
                          <Text style={styles.buttonText}>复制链接</Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          disabled={isBusy}
                          onPress={() => void handleCancelLogin(account)}
                          style={styles.button}
                        >
                          <Text style={styles.buttonText}>取消</Text>
                        </Pressable>
                      </View>
                      <Text style={styles.muted}>2. 粘贴授权码并提交：</Text>
                      <TextInput
                        value={codeDrafts[account.id] ?? ""}
                        onChangeText={(text) =>
                          setCodeDrafts((prev) => ({ ...prev, [account.id]: text }))
                        }
                        placeholder="粘贴授权码或 https://antigravity.google/oauth-callback?code=..."
                        placeholderTextColor={theme.colors.foregroundMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={styles.codeInput}
                      />
                      <View style={styles.actionsRow}>
                        <Pressable
                          accessibilityRole="button"
                          disabled={isBusy}
                          onPress={() => void handleSubmitCode(account)}
                          style={styles.primaryButton}
                        >
                          <Text style={styles.primaryButtonText}>
                            {isBusy ? "验证中..." : "提交授权码"}
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : null}
                </SettingsRow>
              );
            })
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="添加新账号">
        <SettingsCard>
          <SettingsInput
            ref={labelRef}
            label="账号名称"
            hint="用于区分不同账号，例如 Work 或 Personal。"
            placeholder="例如：Work"
            onChangeText={(text) => {
              setNewLabel(text);
              if (!idTouched) {
                const suggested = slugifyId(text);
                setNewId(suggested);
                idRef.current?.replaceText(suggested);
              }
            }}
          />
          <SettingsInput
            ref={idRef}
            label="账号 ID"
            hint="小写字母、数字或连字符，将生成 Provider ID：better-paseo-antigravity-<id>"
            placeholder="例如：work"
            onChangeText={(text) => {
              setIdTouched(true);
              setNewId(text);
            }}
          />
          <SettingsAction
            label="创建独立账号配置"
            hint="通过官方 agy acp --gemini-dir 隔离凭据与会话，不影响真实 HOME 目录。"
            actionLabel={busyId === "__add__" ? "创建中..." : "添加账号"}
            disabled={busyId !== null}
            onPress={() => void handleAdd()}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
