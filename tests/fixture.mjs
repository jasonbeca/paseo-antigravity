import readline from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const send = (m) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const update = (u) =>
  send({
    method: "session/update",
    params: { sessionId: "native", update: u },
  });
const ready = () =>
  update({ sessionUpdate: "available_commands_update", availableCommands: [] });
if (process.argv.includes("--version")) {
  if (process.env.SCENARIO === "slow-init")
    await new Promise((resolve) => setTimeout(resolve, 60));
  console.log("1.5.15");
  process.exit(0);
}
if (process.argv.includes("/usage")) {
  if (process.env.SCENARIO === "strict-home-usage") {
    // Mirror real `agy -p /usage`: ignores GEMINI_HOME and reads token strictly from $HOME/.gemini/antigravity-cli.
    if (
      process.env.XDG_CONFIG_HOME ||
      process.env.ANTIGRAVITY_HOME ||
      process.env.ANTIGRAVITY_APP_DATA_DIR ||
      process.env.ANTIGRAVITY_LS_ADDRESS
    ) {
      process.stderr.write("unexpected leaked env var\n");
      process.exit(2);
    }
    const tokenPath = path.join(
      process.env.HOME || "",
      ".gemini",
      "antigravity-cli",
      "antigravity-oauth-token",
    );
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(tokenPath, "utf8"));
    } catch {
      process.stderr.write("authentication failed: token not found under HOME/.gemini\n");
      process.exit(1);
    }
    const remaining = Number(parsed?.token?.remaining_fraction ?? 0.5);
    console.log(
      JSON.stringify({
        status: "SUCCESS",
        command: {
          name: "usage",
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  {
                    id: "gemini-weekly",
                    name: "Weekly Limit Remaining",
                    window: "weekly",
                    remaining_fraction: remaining,
                    reset_time: "2026-12-01T00:00:00Z",
                  },
                ],
              },
              {
                name: "Claude and GPT models",
                buckets: [
                  {
                    id: "3p-weekly",
                    name: "Weekly Limit Remaining",
                    window: "weekly",
                    remaining_fraction: 1,
                    reset_time: "1970-01-01T00:00:00Z",
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    process.exit(0);
  }
  console.log(
    JSON.stringify({
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini models",
              buckets: [
                {
                  id: "5h",
                  name: "5h Remaining",
                  window: "5h",
                  remaining_fraction: 0.75,
                },
              ],
            },
          ],
        },
      },
    }),
  );
  process.exit(0);
}
let pending;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line),
    r = (result) => send({ id: m.id, result });
  if (m.method === "initialize") {
    if (process.env.SCENARIO === "login-required") {
      console.log(
        "Open the following link to authenticate https://accounts.google.com/?code=fixture-do-not-show",
      );
      return;
    }
    if (process.env.SCENARIO === "slow-init") {
      setTimeout(
        () =>
          r({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
        120,
      );
      return;
    }
    if (process.env.SCENARIO === "init-hang") return;
    if (process.env.SCENARIO === "init-error")
      send({
        id: m.id,
        error: { code: -32603, message: "fixture init failure" },
      });
    else r({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  }
  if (m.method === "session/new") {
    if (process.env.SCENARIO === "new-hang") return;
    if (process.env.SCENARIO === "new-error") {
      console.log("Open the following link to authenticate fixture");
      return;
    }
    r({ sessionId: "native", configOptions: [] });
    setTimeout(ready, 10);
  }
  if (m.method === "session/load") {
    r({});
    ready();
    if (process.env.SCENARIO === "late-history") {
      setTimeout(() => {
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "LATE_HISTORY" },
        });
        update({
          sessionUpdate: "tool_call",
          toolCallId: "late-ghost",
          title: "late",
          kind: "execute",
          status: "in_progress",
          rawInput: {},
        });
      }, 260);
      return;
    }
    update({
      sessionUpdate: "tool_call",
      toolCallId: "old-history",
      title: "history",
      kind: "execute",
      status: "in_progress",
      rawInput: {},
    });
    const frame =
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "native",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "REPLAY_" + "中".repeat(100000) },
          },
        },
      }) + "\n";
    const bytes = Buffer.from(frame);
    let pos = 0;
    const timer = setInterval(() => {
      const end = Math.min(pos + 50003, bytes.length);
      process.stdout.write(bytes.subarray(pos, end));
      pos = end;
      if (pos === bytes.length) clearInterval(timer);
    }, 60);
  }
  if (m.method === "session/close") {
    if (process.env.CLOSE_FILE) writeFileSync(process.env.CLOSE_FILE, "closed");
    r({});
  }
  if (m.method === "session/prompt") {
    const text = m.params.prompt[0].text;
    pending = m.id;
    if (text === "background-first") {
      update({
        sessionUpdate: "tool_call",
        toolCallId: "bg1",
        title: "background",
        kind: "execute",
        status: "in_progress",
        rawInput: {},
      });
      r({ stopReason: "end_turn" });
      pending = undefined;
      return;
    }
    if (text === "background-follow") {
      setTimeout(() => {
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "bg1",
          status: "completed",
        });
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "DONE" },
        });
        r({ stopReason: "end_turn" });
        pending = undefined;
      }, 450);
      return;
    }
    if (text === "silent" || text === "ignore-cancel") return;
    if (text === "exit-17") {
      process.exit(17);
    }
    if (text === "signal-term") {
      process.kill(process.pid, "SIGTERM");
      return;
    }
    if (text === "bad") {
      setTimeout(() => console.log("not ACP"), 20);
      return;
    }
    if (text === "tool" || text === "deferred-bad" || text === "tool-error") {
      update({
        sessionUpdate: "tool_call",
        toolCallId: "live-tool",
        title: "live",
        kind: "execute",
        status: "in_progress",
        rawInput: {},
      });
      if (text === "tool-error") {
        send({
          id: m.id,
          error: { code: -32001, message: "fixture tool failure" },
        });
        pending = undefined;
        return;
      }
      if (text === "deferred-bad") {
        r({ stopReason: "end_turn" });
        setTimeout(() => console.log("not ACP"), 50);
      }
      return;
    }
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "OK" },
    });
    r({ stopReason: "end_turn" });
    pending = undefined;
  }
  if (
    m.method === "session/cancel" &&
    process.env.SCENARIO !== "ignore-cancel" &&
    pending !== undefined
  ) {
    send({ id: pending, result: { stopReason: "cancelled" } });
    pending = undefined;
  }
});
