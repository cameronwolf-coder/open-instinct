/**
 * The owner's LLM Wiki and Hermes fleet, wired in when INSTINCT_WIKI_DIR points at a
 * synced copy of the vault. The vault is the knowledge source of truth; Hal publishes
 * Hermes cron health into it at Machine/Status/hal-cron.json (schema: the vault's
 * System/Automation.md, "Hal Cron Dashboard") and mirrors the owner's own job outputs
 * to Machine/Status/hermes-output/.
 *
 * Everything here is read-only and owner-only (files.read). Four parts:
 * - wiki_read / wiki_ls / wiki_grep: Pi's file tools bound to the vault, same guard as
 *   the workspace tools.
 * - wiki_updates, hermes_status, hermes_output: what changed and what the fleet is doing.
 * - wikiPromptSection: a short live-status block in the owner's system prompt.
 * - HermesWatcher: texts the owner when a job newly fails or the status feed goes stale.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { createGrepTool, createLsTool, createReadTool } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@open-instinct/core";
import type { Principal, RegisteredTool, StateDir, ToolMeta, ToolResultLike } from "@open-instinct/core";
import { resolveInsideWorkspace, workspacePathGuard, wrapAgentTool } from "./file-tools.js";

export const HERMES_STATUS_FILE = "Machine/Status/hal-cron.json";
const WATCH_STATE_FILE = "hermes-watch.json";
/** Poll interval before the first status file syncs: hal-cron-status.timer's OnUnitActiveSec. */
const PUBLISH_INTERVAL_FALLBACK_MINUTES = 15;
/** Directories wiki_updates reports on: compiled knowledge, receipts, journal, operating docs. */
const UPDATE_ROOTS = ["wiki", "raw/agent-runs", "Human/Journal", "System"];

export interface HermesJob {
  id: string;
  profile: string;
  name: string;
  schedule?: string;
  enabled: boolean;
  status: "ok" | "fail" | "paused" | "unknown";
  last_run?: string | null;
  last_error?: string | null;
  failure_streak?: number;
  next_run?: string | null;
  deliver?: string | null;
  log?: string | null;
  output?: string;
  output_at?: string;
}

export interface HermesIncident {
  id: string;
  profile: string;
  job_id: string;
  state: string;
  first_seen: string;
  last_seen: string;
  error: string;
}

export interface HermesStatus {
  generated_at: string;
  interval_minutes: number;
  overall_status: string;
  counts: Record<string, number>;
  kanban: { ok: boolean; errors: string[] };
  incidents: HermesIncident[];
  jobs: HermesJob[];
}

export function readHermesStatus(vault: string): HermesStatus | undefined {
  try {
    return JSON.parse(readFileSync(path.join(vault, HERMES_STATUS_FILE), "utf8")) as HermesStatus;
  } catch {
    return undefined;
  }
}

/** Stale once a full publish interval has been missed: older than two intervals. */
export function hermesStale(status: HermesStatus, now: Date): boolean {
  const age = now.getTime() - Date.parse(status.generated_at);
  return !(age <= 2 * status.interval_minutes * 60_000);
}

const jobKey = (j: Pick<HermesJob, "profile" | "id">) => `${j.profile}/${j.id}`;

function findJob(status: HermesStatus, query: string): HermesJob[] {
  const q = query.trim().toLowerCase();
  const exact = status.jobs.filter((j) => j.id.toLowerCase() === q || jobKey(j).toLowerCase() === q || j.name.toLowerCase() === q);
  return exact.length ? exact : status.jobs.filter((j) => j.name.toLowerCase().includes(q) || jobKey(j).toLowerCase().includes(q));
}

function describeJob(j: HermesJob): string {
  const parts = [`${j.status.toUpperCase()} ${jobKey(j)} "${j.name}"`, `schedule ${j.schedule ?? "?"}`];
  if (j.last_run) parts.push(`last run ${j.last_run}`);
  if (j.next_run && j.enabled) parts.push(`next ${j.next_run}`);
  if (j.failure_streak) parts.push(`failure streak ${j.failure_streak}`);
  if (j.output) parts.push(`output available (hermes_output "${jobKey(j)}")`);
  const line = parts.join(" · ");
  return j.status === "fail" && j.last_error ? `${line}\n  error: ${j.last_error.trim()}` : line;
}

const text = (t: string, isError = false): ToolResultLike => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const meta = (name: string): ToolMeta => ({ capabilities: ["files.read"], group: "files", describe: (args) => `${name} ${JSON.stringify(args ?? {})}` });

function walkChanged(root: string, sinceMs: number, out: { path: string; mtime: number }[], vault: string): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) walkChanged(full, sinceMs, out, vault);
    else if (e.isFile() && e.name.endsWith(".md")) {
      const mtime = statSync(full).mtimeMs;
      if (mtime >= sinceMs) out.push({ path: path.relative(vault, full), mtime });
    }
  }
}

/** LOG.md entries (`## [YYYY-MM-DD] kind | title`) dated on or after `since`, with their bodies. */
export function logEntriesSince(vault: string, since: Date): string[] {
  let log: string;
  try {
    log = readFileSync(path.join(vault, "LOG.md"), "utf8");
  } catch {
    return [];
  }
  const day = since.toISOString().slice(0, 10);
  return log
    .split(/\n(?=## \[)/)
    .filter((block) => {
      const m = /^## \[(\d{4}-\d{2}-\d{2})\]/.exec(block);
      return m !== null && m[1]! >= day;
    })
    .map((b) => b.trim());
}

export function wikiUpdates(vault: string, since: Date): string {
  const changed: { path: string; mtime: number }[] = [];
  for (const root of UPDATE_ROOTS) walkChanged(path.join(vault, root), since.getTime(), changed, vault);
  changed.sort((a, b) => b.mtime - a.mtime);
  const log = logEntriesSince(vault, since);
  const sections = [`Wiki changes since ${since.toISOString()}.`];
  sections.push(log.length ? `LOG.md entries:\n${log.join("\n\n")}` : "LOG.md: no entries in this window.");
  for (const root of UPDATE_ROOTS) {
    const files = changed.filter((c) => c.path.startsWith(root + "/"));
    if (files.length) sections.push(`${root}/ (${files.length} changed, newest first):\n${files.map((f) => `- ${f.path} (${new Date(f.mtime).toISOString()})`).join("\n")}`);
  }
  if (!changed.length) sections.push("No wiki, receipt, journal or System files changed in this window.");
  return sections.join("\n\n");
}

export function hermesSummary(status: HermesStatus, now: Date, filter: "failing" | "all" | "incidents"): string {
  const head = [
    `Hermes on Hal, published ${status.generated_at}${hermesStale(status, now) ? " (STALE: the publisher or Syncthing has missed runs)" : ""}.`,
    `Overall ${status.overall_status}. Jobs: ${Object.entries(status.counts).map(([k, v]) => `${v} ${k}`).join(", ")}.`,
    `Kanban control: ${status.kanban.ok ? "ok" : `not ok: ${status.kanban.errors.join("; ") || "doctor reported not ok"}`}.`,
  ];
  if (filter === "incidents") {
    const lines = status.incidents.map((i) => `- ${i.state} ${i.profile}/${i.job_id} since ${i.first_seen}, last ${i.last_seen}: ${i.error.trim()}`);
    return [...head, `Open incidents (${lines.length}):`, ...(lines.length ? lines : ["none"])].join("\n");
  }
  const jobs = filter === "all" ? status.jobs : status.jobs.filter((j) => j.status === "fail" || j.status === "unknown");
  return [...head, filter === "all" ? "All jobs:" : "Failing or unknown jobs:", ...(jobs.length ? jobs.map(describeJob) : ["none"])].join("\n");
}

export function wikiTools(vault: string, now: () => Date = () => new Date()): RegisteredTool[] {
  const guard = workspacePathGuard(vault);
  const about = " Paths are relative to Cameron's LLM Wiki vault (read-only). Start at ME.md and INDEX.md; compiled knowledge is under wiki/, receipts under raw/agent-runs/.";
  const readOnly: AgentTool<any>[] = [createReadTool(vault), createLsTool(vault), createGrepTool(vault)];
  const pi = readOnly.map((tool) =>
    wrapAgentTool({ ...tool, description: tool.description + about }, meta(`wiki_${tool.name}`), { rename: `wiki_${tool.name}`, guard }),
  );

  const updates = defineTool({
    name: "wiki_updates",
    label: "What changed in the LLM Wiki",
    description: "List LOG.md entries and changed wiki pages, agent-run receipts, journal notes and System docs since a time. Use for 'what's new in the wiki', catch-ups and the daily brief. Read a file with wiki_read for detail.",
    parameters: Type.Object({
      since: Type.Optional(Type.String({ description: "ISO date or datetime. Default: 24 hours ago." })),
    }),
    meta: meta("wiki_updates"),
    execute: async (args) => {
      const since = args.since ? new Date(args.since) : new Date(now().getTime() - 24 * 3600_000);
      if (Number.isNaN(since.getTime())) return text(`Not a date: ${args.since}`, true);
      return text(wikiUpdates(vault, since));
    },
  });

  const status = defineTool({
    name: "hermes_status",
    label: "Hermes cron health",
    description: "Health of every Hermes cron job on Hal (all profiles), open failure incidents and Kanban control, from the status file Hal publishes every interval. filter: failing (default), all, incidents. job: a job id, profile/id or name fragment for one job's detail.",
    parameters: Type.Object({
      filter: Type.Optional(Type.Union([Type.Literal("failing"), Type.Literal("all"), Type.Literal("incidents")])),
      job: Type.Optional(Type.String()),
    }),
    meta: meta("hermes_status"),
    execute: async ({ filter, job }) => {
      const s = readHermesStatus(vault);
      if (!s) return text(`No Hermes status at ${HERMES_STATUS_FILE}. Hal's hal-cron-status.timer publishes it; Syncthing carries it here.`, true);
      if (job) {
        const jobs = findJob(s, job);
        if (!jobs.length) return text(`No Hermes job matches "${job}".`, true);
        const incidents = s.incidents.filter((i) => jobs.some((j) => j.id === i.job_id && j.profile === i.profile));
        return text([...jobs.map(describeJob), ...incidents.map((i) => `incident ${i.state} since ${i.first_seen}: ${i.error.trim()}`)].join("\n"));
      }
      return text(hermesSummary(s, now(), filter ?? "failing"));
    },
  });

  const output = defineTool({
    name: "hermes_output",
    label: "Latest Hermes job output",
    description: "Read what a Hermes job last reported (briefs, digests, reports). Available for Cameron's own profiles (default, abode-growth); client profiles are status-only. job: id, profile/id or name fragment.",
    parameters: Type.Object({ job: Type.String() }),
    meta: meta("hermes_output"),
    execute: async ({ job: query }) => {
      const s = readHermesStatus(vault);
      if (!s) return text(`No Hermes status at ${HERMES_STATUS_FILE}.`, true);
      const jobs = findJob(s, query);
      if (!jobs.length) return text(`No Hermes job matches "${query}".`, true);
      if (jobs.length > 1) return text(`Several jobs match; pick one:\n${jobs.map((j) => `- ${jobKey(j)} "${j.name}"`).join("\n")}`, true);
      const job = jobs[0]!;
      if (!job.output) return text(`${jobKey(job)} has no mirrored output (client profile or no run yet). Status: ${describeJob(job)}`, true);
      const file = resolveInsideWorkspace(vault, job.output);
      if (!file || !existsSync(file)) return text(`Output for ${jobKey(job)} has not synced yet: ${job.output}`, true);
      return text(`${describeJob(job)}\nOutput written ${job.output_at}:\n\n${readFileSync(file, "utf8")}`);
    },
  });

  return [...pi, updates, status, output];
}

/** Live status for the owner's system prompt; nothing for anyone else. */
export function wikiPromptSection(vault: string, principal: Principal, now: Date): string[] {
  if (principal.kind !== "owner" || principal.tier !== "owner") return [];
  const lines = [
    "Cameron's LLM Wiki is your long-term context (read-only): wiki_read, wiki_grep, wiki_ls, wiki_updates. For questions about his work, projects, people or past decisions, start at ME.md and INDEX.md before answering from memory. Hermes is his agent fleet on Hal: hermes_status, hermes_output.",
  ];
  const s = readHermesStatus(vault);
  if (!s) lines.push("Hermes status: unavailable (no status file synced).");
  else {
    const failing = s.jobs.filter((j) => j.status === "fail");
    lines.push(
      `Hermes status ${hermesStale(s, now) ? "is STALE, " : ""}as of ${s.generated_at}: ${s.overall_status}; ${failing.length} failing${failing.length ? `: ${failing.map((j) => `${jobKey(j)} "${j.name}"`).join(", ")}` : ""}; kanban ${s.kanban.ok ? "ok" : "not ok"}.`,
    );
  }
  return [lines.join("\n")];
}

interface WatchState {
  failing: string[];
  staleAlerted: boolean;
}

export interface HermesWatcherOptions {
  vault: string;
  state: StateDir;
  /** Runs the alert as an owner system task; the reply is texted to the owner. */
  alert: (task: { id: string; name: string; prompt: string }) => Promise<unknown>;
  log: (m: string) => void;
  now?: () => Date;
}

/**
 * Texts the owner when a Hermes job newly starts failing or the status feed goes stale.
 * The first check only records a baseline, so a restart never replays known failures.
 * It polls at the publisher's own interval, read from the status file.
 */
export class HermesWatcher {
  private timer?: NodeJS.Timeout;
  constructor(private readonly opts: HermesWatcherOptions) {}

  async check(): Promise<string[]> {
    const now = (this.opts.now ?? (() => new Date()))();
    const s = readHermesStatus(this.opts.vault);
    if (!s) return [];
    const prev = this.opts.state.readJson<WatchState | undefined>(WATCH_STATE_FILE, undefined);
    const failing = s.jobs.filter((j) => j.status === "fail");
    const stale = hermesStale(s, now);
    const next: WatchState = { failing: failing.map(jobKey), staleAlerted: stale && (prev?.staleAlerted ?? false) };
    const alerts: string[] = [];
    if (prev) {
      const fresh = failing.filter((j) => !prev.failing.includes(jobKey(j)));
      if (fresh.length) alerts.push(`Hermes jobs that just started failing:\n${fresh.map(describeJob).join("\n")}`);
      if (stale && !prev.staleAlerted) {
        alerts.push(`The Hermes status feed is stale: last published ${s.generated_at}, expected every ${s.interval_minutes} minutes. Hal's hal-cron-status.timer or Syncthing may be down.`);
        next.staleAlerted = true;
      }
    }
    if (alerts.length) {
      await this.opts.alert({
        id: `hermes-watch-${now.getTime()}`,
        name: "Hermes failure alert",
        prompt: `Text Cameron one short alert about his Hermes fleet. Say which jobs broke and the likely cause in plain words, from the facts below. No fixes unless the error makes one obvious. Use hermes_status for detail if needed.\n\n${alerts.join("\n\n")}`,
      });
    }
    // Only after the alert went out: a failed send leaves the old state, so the next check retries.
    this.opts.state.writeJson(WATCH_STATE_FILE, next);
    return alerts;
  }

  start(): void {
    const tick = async () => {
      try {
        await this.check();
      } catch (error) {
        this.opts.log(`hermes watch: ${error instanceof Error ? error.message : String(error)}`);
      }
      const minutes = readHermesStatus(this.opts.vault)?.interval_minutes;
      this.timer = setTimeout(tick, (minutes && minutes > 0 ? minutes : PUBLISH_INTERVAL_FALLBACK_MINUTES) * 60_000);
      this.timer.unref?.();
    };
    void tick();
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}
