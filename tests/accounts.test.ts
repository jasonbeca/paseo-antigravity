import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_DATA_DIR_NAME,
  accountTokenPath,
  addAccountRecord,
  buildAccountEnv,
  clearAccountToken,
  isAccountSignedIn,
  loadAccountProfilesSync,
  prepareAccountProfile,
  removeAccountRecord,
} from "../server/accounts.ts";
import {
  AccountLoginManager,
  extractAuthorizationCode,
  parseOfficialAuthUrl,
} from "../server/login.ts";
import { provider } from "../server/provider.ts";
import { Usage } from "../server/usage.ts";

const fixture = fileURLToPath(new URL("./fixture.mjs", import.meta.url));

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test("account store CRUD validates slugs, persists atomically, and handles removal", () => {
  const rootDir = makeTempDir("paseo-agy-store-");
  const fakeHome = makeTempDir("paseo-agy-home-");
  try {
    assert.deepEqual(loadAccountProfilesSync({ rootDir, userHome: fakeHome }), []);

    const work = addAccountRecord(
      { id: "work", label: "Work" },
      { rootDir, userHome: fakeHome },
    );
    assert.equal(work.providerId, "better-paseo-antigravity-work");
    assert.equal(work.providerLabel, "Better Paseo Antigravity (Work)");
    assert.equal(isAccountSignedIn(work.profileDir), false);

    assert.throws(() =>
      addAccountRecord({ id: "work", label: "Duplicate" }, { rootDir, userHome: fakeHome }),
    );
    assert.throws(() =>
      addAccountRecord({ id: "Bad_ID", label: "Invalid" }, { rootDir, userHome: fakeHome }),
    );

    // Simulate token created by official CLI
    const tokenFile = accountTokenPath(work.profileDir);
    writeFileSync(tokenFile, '{"token":{"access_token":"dummy"}}', { mode: 0o600 });
    assert.equal(isAccountSignedIn(work.profileDir), true);

    assert.equal(clearAccountToken(work.profileDir), true);
    assert.equal(isAccountSignedIn(work.profileDir), false);

    // Keep profile dir by default when removing
    writeFileSync(tokenFile, '{"token":{"access_token":"dummy"}}', { mode: 0o600 });
    assert.equal(
      removeAccountRecord("work", { rootDir, userHome: fakeHome, deleteProfile: false }),
      true,
    );
    assert.equal(isAccountSignedIn(work.profileDir), false);
    assert.equal(existsSync(work.profileDir), true);
    assert.deepEqual(loadAccountProfilesSync({ rootDir, userHome: fakeHome }), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("prepareAccountProfile links global rules/skills without linking tokens or conversations", () => {
  const fakeHome = makeTempDir("paseo-agy-link-home-");
  const profileDir = makeTempDir("paseo-agy-link-profile-");
  try {
    const realGemini = path.join(fakeHome, ".gemini");
    mkdirSync(path.join(realGemini, "config", "skills"), { recursive: true });
    mkdirSync(path.join(realGemini, APP_DATA_DIR_NAME, "skills"), { recursive: true });
    mkdirSync(path.join(realGemini, APP_DATA_DIR_NAME, "conversations"), { recursive: true });
    writeFileSync(path.join(realGemini, "GEMINI.md"), "# Global rule\n");
    writeFileSync(path.join(realGemini, "config", "skills.json"), "{}\n");
    writeFileSync(path.join(realGemini, APP_DATA_DIR_NAME, "antigravity-oauth-token"), "secret");

    prepareAccountProfile(profileDir, fakeHome);

    assert.equal(lstatSync(path.join(profileDir, "GEMINI.md")).isSymbolicLink(), true);
    assert.equal(
      readlinkSync(path.join(profileDir, "GEMINI.md")),
      path.join(realGemini, "GEMINI.md"),
    );
    assert.equal(lstatSync(path.join(profileDir, "config", "skills")).isSymbolicLink(), true);
    assert.equal(
      lstatSync(path.join(profileDir, APP_DATA_DIR_NAME, "skills")).isSymbolicLink(),
      true,
    );
    // Never link tokens or conversations!
    assert.equal(existsSync(accountTokenPath(profileDir)), false);
    assert.equal(existsSync(path.join(profileDir, APP_DATA_DIR_NAME, "conversations")), false);

    // Removing source cleans up dangling symlink on next prepare
    unlinkSync(path.join(realGemini, "GEMINI.md"));
    prepareAccountProfile(profileDir, fakeHome);
    assert.equal(existsSync(path.join(profileDir, "GEMINI.md")), false);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("buildAccountEnv preserves HOME, injects GEMINI_HOME + AGY_CLI_FORCE_FILE_TOKEN_STORAGE, and strips ambient keys", () => {
  const env = buildAccountEnv(
    {
      HOME: "/Users/alice",
      PATH: "/usr/bin",
      GEMINI_API_KEY: "ambient-key",
      GOOGLE_API_KEY: "ambient-google",
      GEMINI_HOME: "/old/gemini",
      ANTIGRAVITY_GEMINI_DIR: "/old/agy-gemini",
      AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "0",
    },
    "/tmp/profile-work",
  );
  assert.equal(env.HOME, "/Users/alice");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.GEMINI_HOME, path.resolve("/tmp/profile-work"));
  assert.equal(env.SSH_CONNECTION, "127.0.0.1 0 127.0.0.1 0");
  assert.equal(env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE, "1");
  assert.equal(env.AGY_ACP_FORCE_FILE_STORAGE, "1");
  assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, "1");
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.GOOGLE_API_KEY, undefined);
  assert.equal(env.ANTIGRAVITY_GEMINI_DIR, undefined);
});

test("extractAuthorizationCode and parseOfficialAuthUrl validate inputs strictly", () => {
  assert.equal(extractAuthorizationCode("  4/0AbCdEf_123  "), "4/0AbCdEf_123");
  assert.equal(
    extractAuthorizationCode(
      "https://antigravity.google/oauth-callback?state=abc&code=4%2F0XYZ_999&scope=openid",
    ),
    "4/0XYZ_999",
  );
  assert.throws(() => extractAuthorizationCode("   "));
  assert.throws(() => extractAuthorizationCode("https://antigravity.google/oauth-callback?state=abc"));
  assert.throws(() => extractAuthorizationCode("has spaces"));

  const validUrl =
    "https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=xyz";
  assert.equal(
    parseOfficialAuthUrl(`Authentication required. Please visit:\n  ${validUrl}\n`),
    validUrl,
  );
  // Reject non-Google or wrong redirect_uri URLs
  assert.equal(
    parseOfficialAuthUrl(
      "https://evil.example.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback",
    ),
    undefined,
  );
  assert.equal(
    parseOfficialAuthUrl(
      "https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fevil.example.com%2Fcb",
    ),
    undefined,
  );
});

test("AccountLoginManager drives official --login flow and cleans up on submit/cancel", async () => {
  const rootDir = makeTempDir("paseo-agy-login-");
  const fakeHome = makeTempDir("paseo-agy-login-home-");
  const mockCli = path.join(rootDir, "mock-agy.mjs");
  writeFileSync(
    mockCli,
    `
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
const url = "https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=test";
console.log("Authentication required. Please visit the URL to log in:\\n  " + url);
const rl = readline.createInterface({ input: process.stdin });
rl.once("line", (code) => {
  if (code.trim() === "GOOD_CODE") {
    const dir = path.join(process.env.GEMINI_HOME, "antigravity-cli");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "antigravity-oauth-token"), '{"token":{"access_token":"ok"}}');
    process.exit(0);
  }
  process.exit(1);
});
`,
  );

  const account = addAccountRecord(
    { id: "team", label: "Team" },
    { rootDir, userHome: fakeHome },
  );
  const manager = new AccountLoginManager({
    command: process.execPath,
    baseArgs: [mockCli],
    baseEnv: { PATH: process.env.PATH, HOME: fakeHome },
    userHome: fakeHome,
    urlTimeoutMs: 5_000,
    sessionTimeoutMs: 30_000,
    completeTimeoutMs: 5_000,
  });

  try {
    const started = await manager.start(account);
    assert.match(started.authUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth/);
    assert.equal(manager.getState(account.id).loginInProgress, true);

    const signedIn = await manager.submitCode(
      account.id,
      "https://antigravity.google/oauth-callback?code=GOOD_CODE&state=test",
    );
    assert.equal(signedIn, true);
    assert.equal(isAccountSignedIn(account.profileDir), true);
    assert.equal(manager.getState(account.id).loginInProgress, false);

    // Start again and cancel cleanly
    await manager.start(account);
    assert.equal(await manager.cancel(account.id), true);
    assert.equal(manager.getState(account.id).loginInProgress, false);
  } finally {
    await manager.cancelAll();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("account provider status and catalog cache key stay isolated per account", async () => {
  const rootDir = makeTempDir("paseo-agy-prov-");
  const fakeHome = makeTempDir("paseo-agy-prov-home-");
  try {
    const account = addAccountRecord(
      { id: "work", label: "Work" },
      { rootDir, userHome: fakeHome },
    );
    const p = provider({ account, userHome: fakeHome });

    assert.equal(p.id, "better-paseo-antigravity-work");
    assert.equal(p.label, "Better Paseo Antigravity (Work)");
    assert.equal(p.catalogRefresh, "on_demand");

    const keyBefore = await p.getCatalogCacheKey!({ scope: "global" });
    assert.match(keyBefore!, /signed-out/);

    // Signed out: status fails fast with guidance
    const launch = {
      command: process.execPath,
      args: [fixture, "acp"],
      env: { PATH: process.env.PATH ?? "", HOME: fakeHome },
    };
    const statusOut = await p.status!({ launch });
    assert.equal(statusOut.available, false);
    assert.match(statusOut.diagnostic!, /尚未登录/);

    // Simulate sign-in
    writeFileSync(accountTokenPath(account.profileDir), '{"token":{"access_token":"ok"}}');
    const keyAfter = await p.getCatalogCacheKey!({ scope: "global" });
    assert.match(keyAfter!, /signed-in/);
    assert.notEqual(keyBefore, keyAfter);

    const statusIn = await p.status!({ launch });
    assert.equal(statusIn.available, true);
    assert.match(statusIn.diagnostic!, /独立账号配置：Work/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("multi-account usage isolates HOME per account for print-mode agy /usage and normalizes epoch-0 resets", async () => {
  const rootDir = makeTempDir("paseo-agy-usage-iso-");
  const fakeHome = makeTempDir("paseo-agy-usage-home-");
  try {
    const work = addAccountRecord(
      { id: "work", label: "Work" },
      { rootDir, userHome: fakeHome },
    );
    const personal = addAccountRecord(
      { id: "personal", label: "Personal" },
      { rootDir, userHome: fakeHome },
    );

    // Put distinct tokens in each profile, and a decoy token in real ~/.gemini
    writeFileSync(
      accountTokenPath(work.profileDir),
      JSON.stringify({ token: { access_token: "work", remaining_fraction: 0.8 } }),
    );
    writeFileSync(
      accountTokenPath(personal.profileDir),
      JSON.stringify({ token: { access_token: "personal", remaining_fraction: 0.25 } }),
    );
    mkdirSync(path.join(fakeHome, ".gemini", APP_DATA_DIR_NAME), { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".gemini", APP_DATA_DIR_NAME, "antigravity-oauth-token"),
      JSON.stringify({ token: { access_token: "default", remaining_fraction: 0.1 } }),
    );

    const baseLaunch = {
      command: process.execPath,
      args: [fixture, "acp"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: fakeHome,
        SCENARIO: "strict-home-usage",
        XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
        ANTIGRAVITY_HOME: path.join(fakeHome, ".gemini", APP_DATA_DIR_NAME),
        ANTIGRAVITY_APP_DATA_DIR: path.join(fakeHome, ".gemini", APP_DATA_DIR_NAME),
        ANTIGRAVITY_LS_ADDRESS: "localhost:9999",
      },
    };

    const workUsageObj = new Usage(work, fakeHome);
    const personalUsageObj = new Usage(personal, fakeHome);
    const workUsage = workUsageObj.registration();
    const personalUsage = personalUsageObj.registration();

    const [workDiscovered, personalDiscovered] = await Promise.all([
      workUsage.discover({ kind: "global", launch: baseLaunch }),
      personalUsage.discover({ kind: "global", launch: baseLaunch }),
    ]);
    assert.equal(workDiscovered.length, 1);
    assert.equal(personalDiscovered.length, 1);
    assert.equal(workDiscovered[0]?.provider, work.providerId);
    assert.equal(personalDiscovered[0]?.provider, personal.providerId);

    // Before manual refresh: fetch returns unavailable and never runs agy
    assert.equal((await workUsage.fetch(workDiscovered[0]!.input)).status, "unavailable");
    assert.equal((await personalUsage.fetch(personalDiscovered[0]!.input)).status, "unavailable");

    // Manual refresh populates isolated per-account caches
    await Promise.all([workUsageObj.refreshNow(), personalUsageObj.refreshNow()]);

    const [workReport, personalReport] = await Promise.all([
      workUsage.fetch(workDiscovered[0]!.input),
      personalUsage.fetch(personalDiscovered[0]!.input),
    ]);

    assert.equal(workReport.status, "available");
    assert.equal(personalReport.status, "available");
    if (workReport.status === "available" && personalReport.status === "available") {
      const workGemini = workReport.windows.find((w) => w.id === "gemini-weekly");
      const work3p = workReport.windows.find((w) => w.id === "3p-weekly");
      const personalGemini = personalReport.windows.find((w) => w.id === "gemini-weekly");

      assert.equal(Math.round(workGemini!.usedPct!), 20);
      assert.equal(workGemini!.resetsAt, "2026-12-01T00:00:00Z");
      assert.equal(work3p!.usedPct, 0);
      assert.equal(work3p!.resetsAt, null);

      assert.equal(Math.round(personalGemini!.usedPct!), 75);
    }

    // Real profile tokens remain intact after synthetic HOME cleanup
    assert.equal(isAccountSignedIn(work.profileDir), true);
    assert.equal(isAccountSignedIn(personal.profileDir), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
