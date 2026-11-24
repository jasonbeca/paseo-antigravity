import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AccountsSettings } from "./client/accounts-settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "accounts",
    title: "账号管理",
    icon: "Users",
    Component: AccountsSettings,
  });
  return () => {};
}
