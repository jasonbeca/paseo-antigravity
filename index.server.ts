import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  BASE_PROVIDER_ID,
  addAccountRpc,
  cancelAccountLoginRpc,
  listAccountsRpc,
  logoutAccountRpc,
  removeAccountRpc,
  startAccountLoginRpc,
  submitAccountLoginCodeRpc,
  type AccountSummary,
} from "./shared/accounts";
import {
  addAccountRecord,
  clearAccountToken,
  isAccountSignedIn,
  loadAccountProfilesSync,
  removeAccountRecord,
  type AccountProfile,
} from "./server/accounts";
import { AccountLoginManager } from "./server/login";
import { provider } from "./server/provider";
import { Usage } from "./server/usage";

export default function contribute(server: PluginServerContext) {
  // Default provider preserves existing single-account CLI login untouched.
  server.registerUsageSource(new Usage().registration());
  server.registerProvider(provider());

  // Multi-account isolated instances (T3 Code pattern: GEMINI_HOME + --gemini-dir + SSH_CONNECTION).
  const initialAccounts = loadAccountProfilesSync();
  const activeAccountIds = new Set(initialAccounts.map((account) => account.id));
  const activeProviderIds = [
    BASE_PROVIDER_ID,
    ...initialAccounts.map((account) => account.providerId),
  ];

  for (const account of initialAccounts) {
    server.registerUsageSource(new Usage(account).registration());
    server.registerProvider(provider({ account }));
  }

  const loginManager = new AccountLoginManager();

  const summarize = (account: AccountProfile): AccountSummary => {
    const login = loginManager.getState(account.id);
    return {
      id: account.id,
      label: account.label,
      providerId: account.providerId,
      profileDir: account.profileDir,
      signedIn: isAccountSignedIn(account.profileDir),
      activeInRuntime: activeAccountIds.has(account.id),
      createdAt: account.createdAt,
      loginInProgress: login.loginInProgress,
      ...(login.authUrl ? { authUrl: login.authUrl } : {}),
    };
  };

  const computeNeedsReload = (accounts: readonly AccountProfile[]): boolean => {
    if (accounts.length !== activeAccountIds.size) return true;
    return accounts.some((account) => !activeAccountIds.has(account.id));
  };

  server.handle(listAccountsRpc, () => {
    const accounts = loadAccountProfilesSync();
    return {
      accounts: accounts.map(summarize),
      needsReload: computeNeedsReload(accounts),
      activeProviderIds,
    };
  });

  server.handle(addAccountRpc, ({ id, label }) => {
    const profile = addAccountRecord({ id, label });
    const accounts = loadAccountProfilesSync();
    return {
      account: summarize(profile),
      needsReload: computeNeedsReload(accounts),
    };
  });

  server.handle(removeAccountRpc, async ({ id, deleteProfile }) => {
    await loginManager.cancel(id);
    const removed = removeAccountRecord(id, { deleteProfile });
    const accounts = loadAccountProfilesSync();
    return {
      removed,
      needsReload: computeNeedsReload(accounts),
    };
  });

  server.handle(logoutAccountRpc, async ({ id }) => {
    await loginManager.cancel(id);
    const account = loadAccountProfilesSync().find((entry) => entry.id === id);
    if (!account) throw new Error(`未找到账号「${id}」。`);
    const signedOut = clearAccountToken(account.profileDir);
    return { signedOut };
  });

  server.handle(startAccountLoginRpc, async ({ id }) => {
    const account = loadAccountProfilesSync().find((entry) => entry.id === id);
    if (!account) throw new Error(`未找到账号「${id}」。`);
    return await loginManager.start(account);
  });

  server.handle(submitAccountLoginCodeRpc, async ({ id, code }) => {
    const signedIn = await loginManager.submitCode(id, code);
    return { signedIn };
  });

  server.handle(cancelAccountLoginRpc, async ({ id }) => {
    const canceled = await loginManager.cancel(id);
    return { canceled };
  });

  return async () => {
    await loginManager.cancelAll();
  };
}
