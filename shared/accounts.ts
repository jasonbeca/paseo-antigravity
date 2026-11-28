import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const BASE_PROVIDER_ID = "better-paseo-antigravity";
export const BASE_PROVIDER_LABEL = "Better Paseo Antigravity";

export const accountIdSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,31}$/,
    "账号 ID 需为 1-32 位小写字母、数字或连字符，且以字母或数字开头。",
  );

export const accountLabelSchema = z
  .string()
  .trim()
  .min(1, "账号名称不能为空。")
  .max(48, "账号名称不能超过 48 个字符。");

export function accountProviderId(accountId: string): string {
  return `${BASE_PROVIDER_ID}-${accountId}`;
}

export function accountProviderLabel(label: string): string {
  return `${BASE_PROVIDER_LABEL} (${label})`;
}

export const accountSummarySchema = z.object({
  id: accountIdSchema,
  label: accountLabelSchema,
  providerId: z.string(),
  profileDir: z.string(),
  signedIn: z.boolean(),
  activeInRuntime: z.boolean(),
  createdAt: z.string(),
  loginInProgress: z.boolean(),
  authUrl: z.string().optional(),
  usageUpdatedAt: z.string().optional(),
});

export type AccountSummary = z.infer<typeof accountSummarySchema>;

export const listAccountsRpc = defineRpc({
  name: "accounts.list",
  input: z.object({}).strict(),
  output: z.object({
    accounts: z.array(accountSummarySchema),
    needsReload: z.boolean(),
    activeProviderIds: z.array(z.string()),
  }),
});

export const addAccountRpc = defineRpc({
  name: "accounts.add",
  input: z
    .object({
      id: accountIdSchema,
      label: accountLabelSchema,
    })
    .strict(),
  output: z.object({
    account: accountSummarySchema,
    needsReload: z.boolean(),
  }),
});

export const removeAccountRpc = defineRpc({
  name: "accounts.remove",
  input: z
    .object({
      id: accountIdSchema,
      deleteProfile: z.boolean().optional(),
    })
    .strict(),
  output: z.object({
    removed: z.boolean(),
    needsReload: z.boolean(),
  }),
});

export const logoutAccountRpc = defineRpc({
  name: "accounts.logout",
  input: z.object({ id: accountIdSchema }).strict(),
  output: z.object({
    signedOut: z.boolean(),
  }),
});

export const startAccountLoginRpc = defineRpc({
  name: "accounts.login.start",
  input: z.object({ id: accountIdSchema }).strict(),
  output: z.object({
    authUrl: z.string(),
    expiresAt: z.string(),
  }),
});

export const submitAccountLoginCodeRpc = defineRpc({
  name: "accounts.login.submit_code",
  input: z
    .object({
      id: accountIdSchema,
      code: z.string().trim().min(1, "请输入授权码或回调链接。"),
    })
    .strict(),
  output: z.object({
    signedIn: z.boolean(),
  }),
});

export const cancelAccountLoginRpc = defineRpc({
  name: "accounts.login.cancel",
  input: z.object({ id: accountIdSchema }).strict(),
  output: z.object({
    canceled: z.boolean(),
  }),
});

export const refreshAccountUsageRpc = defineRpc({
  name: "accounts.usage.refresh",
  input: z
    .object({
      id: z.union([z.literal("default"), accountIdSchema]),
    })
    .strict(),
  output: z.object({
    refreshed: z.boolean(),
    fetchedAt: z.string(),
    summary: z.string(),
    fromCache: z.boolean().optional(),
    cooldownRemainingSec: z.number().optional(),
  }),
});
