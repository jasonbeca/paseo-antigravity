import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { provider } from "../server/provider.ts";
import { Usage, parseStatusLineUsageSnapshot } from "../server/usage.ts";
const fixture = fileURLToPath(new URL("./fixture.mjs", import.meta.url));
const launch = (scenario = "") => ({
  command: process.execPath,
  args: [fixture, "acp"],
  env: { SCENARIO: scenario, SSH_TTY: "fixture" },
});
test("status validates ACP handshake, not just executable version", async () => {
  const p = provider();
  const good = await p.status!({ launch: launch() });
  assert.equal(good.available, true);
  assert.match(good.diagnostic!, /SSH_TTY/);
  assert.equal(
    (await p.status!({ launch: launch("init-error") })).available,
    false,
  );
});
test("status retains safe login diagnostic without printing authorization URL", async () => {
  const result = await provider().status!({ launch: launch("login-required") });
  assert.equal(result.available, false);
  assert.match(result.diagnostic!, /登录/);
  assert.doesNotMatch(
    result.diagnostic!,
    /accounts\.google|fixture-do-not-show/,
  );
});
test("status uses one cold-start budget for version and handshake", async () => {
  const result = await provider({ statusTimeoutMs: 1000 }).status!({
    launch: launch("slow-init"),
  });
  assert.equal(result.available, true);
});
test("status timeout remains bounded and reports the failed phase", async () => {
  const at = Date.now();
  const result = await provider({ statusTimeoutMs: 150 }).status!({
    launch: launch("init-hang"),
  });
  assert.equal(result.available, false);
  assert.match(result.diagnostic!, /ACP|initialize/);
  assert.ok(Date.now() - at < 2000);
});
test("installation inspect preserves custom prefix without acp", async () => {
  const p = provider();
  assert.equal(p.catalogRefresh, "on_demand");
  const result = await p.installation!.inspect!({
    launch: { ...launch(), args: [fixture], resolved: true },
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "installed");
  if (result.status === "installed") assert.equal(result.version, "1.5.15");
});
test("StatusLine usage source reads local statusline-usage.json without running agy", async () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), "paseo-agy-sl-usage-"));
  try {
    const p = provider();
    const s = new Usage(undefined, fakeHome).registration();
    assert.equal(s.id, p.id);
    assert.equal(s.provider, p.id);
    assert.equal(s.label, p.label);

    const accounts = await s.discover({ kind: "global" });
    assert.equal(accounts.length, 1);

    // Missing file returns unavailable with guidance
    const missing = await s.fetch(accounts[0]!.input);
    assert.equal(missing.status, "unavailable");

    // Write captured statusline snapshot
    const appDir = path.join(fakeHome, ".gemini", "antigravity-cli");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      path.join(appDir, "statusline-usage.json"),
      JSON.stringify({
        captured_at: "2026-11-28T01:00:00.000Z",
        data: {
          quota: {
            five_hour: { remaining_fraction: 0.75, reset_in_seconds: 3600 },
            weekly: { remaining_fraction: 0.4, reset_time: "2026-12-04T00:00:00Z" },
          },
        },
      }),
    );

    const result = await s.fetch(accounts[0]!.input);
    assert.equal(result.status, "available");
    if (result.status === "available") {
      assert.equal(result.observedAt, "2026-11-28T01:00:00.000Z");
      assert.equal(result.windows.length, 2);
      const fiveH = result.windows.find((w) => w.id === "five_hour");
      const weekly = result.windows.find((w) => w.id === "weekly");
      assert.equal(Math.round(fiveH!.usedPct!), 25);
      assert.equal(fiveH!.resetsAt, "2026-11-28T02:00:00.000Z");
      assert.equal(Math.round(weekly!.usedPct!), 60);
      assert.equal(weekly!.summary, true);
      assert.equal(weekly!.resetsAt, "2026-12-04T00:00:00.000Z");
    }

    // Also supports rate_limits fallback format
    const rl = parseStatusLineUsageSnapshot(
      {
        rate_limits: {
          five_hour: { used_percentage: 30, resets_at: 1795831200 },
          seven_day: { used_percentage: 55, resets_at: 1796436000 },
        },
      },
      new Date("2026-11-28T01:00:00.000Z"),
    );
    assert.equal(rl.status, "available");
    if (rl.status === "available") {
      assert.equal(rl.windows.length, 2);
      assert.equal(rl.windows[0]?.usedPct, 30);
      assert.equal(rl.windows[1]?.usedPct, 55);
    }

    assert.equal(
      (await s.discover({ kind: "session", provider: p.id, env: {} })).length,
      1,
    );
    assert.deepEqual(
      await s.discover({ kind: "session", provider: "other-provider", env: {} }),
      [],
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
