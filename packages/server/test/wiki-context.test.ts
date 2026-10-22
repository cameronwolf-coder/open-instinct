import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateDir } from "@open-instinct/core";
import type { Principal } from "@open-instinct/core";
import { HERMES_STATUS_FILE, HermesWatcher, logEntriesSince, wikiPromptSection, wikiUpdates } from "../src/wiki-context.js";
import type { HermesJob, HermesStatus } from "../src/wiki-context.js";

const owner: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Cameron" };
const partner: Principal = { kind: "contact", id: "contact:sam", tier: "partner", displayName: "Sam" };
const now = new Date("2026-10-22T18:00:00Z");

function job(id: string, status: HermesJob["status"], extra: Partial<HermesJob> = {}): HermesJob {
  return { id, profile: "default", name: `Job ${id}`, schedule: "0 8 * * *", enabled: status !== "paused", status, ...extra };
}

function publish(vault: string, jobs: HermesJob[], generatedAt = now): void {
  const status: HermesStatus = {
    generated_at: generatedAt.toISOString(),
    interval_minutes: 15,
    overall_status: jobs.some((j) => j.status === "fail") ? "fail" : "ok",
    counts: {},
    kanban: { ok: true, errors: [] },
    incidents: [],
    jobs,
  };
  mkdirSync(join(vault, "Machine/Status"), { recursive: true });
  writeFileSync(join(vault, HERMES_STATUS_FILE), JSON.stringify(status));
}

describe("HermesWatcher", () => {
  let vault: string;
  let state: StateDir;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "instinct-wiki-"));
    state = new StateDir(mkdtempSync(join(tmpdir(), "instinct-wiki-state-")));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(state.root, { recursive: true, force: true });
  });

  it("stays silent on the first check, then alerts once per newly failing job", async () => {
    const alert = vi.fn(async () => "sent");
    const watcher = new HermesWatcher({ vault, state, alert, log: () => {}, now: () => now });

    publish(vault, [job("a", "fail"), job("b", "ok")]);
    expect(await watcher.check()).toEqual([]);

    publish(vault, [job("a", "fail"), job("b", "fail", { last_error: "exit 2" })]);
    const alerts = await watcher.check();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("default/b");
    expect(alerts[0]).not.toContain("default/a");
    expect(alerts[0]).toContain("exit 2");

    expect(await watcher.check()).toEqual([]);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("alerts again when a recovered job fails a second time", async () => {
    const watcher = new HermesWatcher({ vault, state, alert: async () => "sent", log: () => {}, now: () => now });
    publish(vault, [job("a", "ok")]);
    await watcher.check();
    publish(vault, [job("a", "fail")]);
    expect(await watcher.check()).toHaveLength(1);
    publish(vault, [job("a", "ok")]);
    expect(await watcher.check()).toEqual([]);
    publish(vault, [job("a", "fail")]);
    expect(await watcher.check()).toHaveLength(1);
  });

  it("retries the alert on the next check when sending it failed", async () => {
    const alert = vi.fn().mockRejectedValueOnce(new Error("model down")).mockResolvedValue("sent");
    const watcher = new HermesWatcher({ vault, state, alert, log: () => {}, now: () => now });
    publish(vault, [job("a", "ok")]);
    await watcher.check();
    publish(vault, [job("a", "fail")]);
    await expect(watcher.check()).rejects.toThrow("model down");
    expect(await watcher.check()).toHaveLength(1);
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it("alerts once when the status feed goes stale and again only after it recovers", async () => {
    let clock = now;
    const watcher = new HermesWatcher({ vault, state, alert: async () => "sent", log: () => {}, now: () => clock });
    publish(vault, [job("a", "ok")]);
    await watcher.check();
    clock = new Date(now.getTime() + 31 * 60_000);
    const stale = await watcher.check();
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain("stale");
    expect(await watcher.check()).toEqual([]);
    publish(vault, [job("a", "ok")], clock);
    expect(await watcher.check()).toEqual([]);
    clock = new Date(clock.getTime() + 31 * 60_000);
    expect(await watcher.check()).toHaveLength(1);
  });
});

describe("wikiPromptSection", () => {
  it("gives the owner the failing jobs and nobody else anything", () => {
    const vault = mkdtempSync(join(tmpdir(), "instinct-wiki-"));
    publish(vault, [job("a", "fail", { name: "Nightly compile" }), job("b", "ok")]);
    const [section] = wikiPromptSection(vault, owner, now);
    expect(section).toContain('1 failing: default/a "Nightly compile"');
    expect(wikiPromptSection(vault, partner, now)).toEqual([]);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("wikiUpdates", () => {
  it("reports LOG.md entries and files changed inside the window only", () => {
    const vault = mkdtempSync(join(tmpdir(), "instinct-wiki-"));
    writeFileSync(join(vault, "LOG.md"), "# Log\n\n## [2026-10-20] ingest | Old\n- a\n\n## [2026-10-22] query | New\n- b\n");
    mkdirSync(join(vault, "wiki/entities"), { recursive: true });
    writeFileSync(join(vault, "wiki/entities/new.md"), "x");
    writeFileSync(join(vault, "wiki/entities/old.md"), "x");
    const old = new Date("2026-10-01T00:00:00Z");
    utimesSync(join(vault, "wiki/entities/old.md"), old, old);
    const since = new Date("2026-10-21T00:00:00Z");

    expect(logEntriesSince(vault, since)).toEqual(["## [2026-10-22] query | New\n- b"]);
    const report = wikiUpdates(vault, since);
    expect(report).toContain("wiki/entities/new.md");
    expect(report).not.toContain("old.md");
    rmSync(vault, { recursive: true, force: true });
  });
});
