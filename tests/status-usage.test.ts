import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { provider } from "../server/provider.ts";
import { Usage } from "../server/usage.ts";
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
test("Plugin usage source only reads cache in fetch and updates on manual refreshNow", async () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), "paseo-agy-manual-usage-"));
  try {
    const usage = new Usage(undefined, fakeHome);
    const s = usage.registration();
    const p = provider();
    assert.equal(p.id, "better-paseo-antigravity");
    assert.equal(p.label, "Better Paseo Antigravity");
    assert.equal(s.id, p.id);
    assert.equal(s.provider, p.id);
    assert.equal(s.label, p.label);

    const accounts = await s.discover({ kind: "global", launch: launch() });
    assert.equal(accounts.length, 1);

    // Before manual refresh: fetch never runs agy and returns unavailable
    const before = await s.fetch(accounts[0]!.input);
    assert.equal(before.status, "unavailable");

    // Manual refresh runs agy -p /usage once and writes persistent cache;
    // concurrent clicks share the single in-flight promise.
    const [refreshed, concurrent] = await Promise.all([
      usage.refreshNow(),
      usage.refreshNow(),
    ]);
    assert.equal(refreshed.report.status, "available");
    assert.equal(refreshed.fromCache, false);
    assert.equal(concurrent.fetchedAt, refreshed.fetchedAt);
    assert.match(refreshed.summary, /25%/);

    // Repeating within 60s cooldown returns cached result without spawning agy
    const cooled = await usage.refreshNow();
    assert.equal(cooled.fromCache, true);
    assert.equal(cooled.fetchedAt, refreshed.fetchedAt);
    assert.ok((cooled.cooldownRemainingSec ?? 0) >= 1);

    // Subsequent fetch reads cached report without spawning agy
    const result = await s.fetch(accounts[0]!.input);
    assert.equal(result.status, "available");
    if (result.status === "available") {
      assert.equal(result.observedAt, refreshed.fetchedAt);
      assert.equal(result.windows.length, 1);
      assert.equal(result.windows[0]?.usedPct, 25);
    }

    assert.equal(
      (await s.discover({
        kind: "session",
        provider: p.id,
        env: {},
        launch: launch(),
      })).length,
      1,
    );
    assert.deepEqual(
      await s.discover({
        kind: "session",
        provider: "antigravity-plus",
        env: {},
        launch: launch(),
      }),
      [],
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
