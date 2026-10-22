import { StateDir } from "@open-instinct/core";
import type { RegisteredTool, ToolContext, ToolResultLike } from "@open-instinct/core";
import { Type } from "typebox";
import { ComposioApps, type ComposioAppsOptions, type ToolkitStatus } from "./composio.js";

export interface ConnectionSummary { id: string; userId: string; toolkit: string; status: string; }

/** Raw v3 preserves connection owner IDs omitted by the SDK's response transform. */
export async function projectConnections(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<ConnectionSummary[]> {
  const accounts: ConnectionSummary[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL("https://backend.composio.dev/api/v3/connected_accounts");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetchImpl(url, { headers: { "x-api-key": apiKey } });
    if (!response.ok) throw new Error(`Composio connection inventory HTTP ${response.status}; request ${response.headers.get("x-request-id") || "unavailable"}`);
    const data = await response.json() as { items: Array<{ id: string; user_id: string; toolkit: { slug: string }; status: string }>; next_cursor?: string };
    for (const item of data.items) accounts.push({ id: item.id, userId: item.user_id, toolkit: item.toolkit.slug, status: item.status });
    cursor = data.next_cursor || undefined;
  } while (cursor);
  return accounts;
}

export function activeAccountsForGroup(inventory: ConnectionSummary[], userId: string): Record<string, string[]> {
  const selected: Record<string, string[]> = {};
  for (const account of inventory) {
    if (account.userId === userId && account.status === "ACTIVE") (selected[account.toolkit] ??= []).push(account.id);
  }
  return selected;
}

export function routeTool(name: string, entries: Map<string, RegisteredTool>): RegisteredTool {
  const first = entries.values().next().value!;
  const schema = first.spec.parameters as Record<string, any>;
  return { spec: {
    ...first.spec,
    name,
    description: first.spec.description + " Select account_group explicitly. Use the group the owner names; ask when the account is ambiguous. Never reuse another group's session_id or connected account ID.",
    parameters: Type.Unsafe({ ...schema, properties: { ...schema.properties, account_group: { type: "string", enum: [...entries.keys()], description: "Composio account group to use for this action." } }, required: [...(schema.required || []), "account_group"] }),
    execute: async (args: unknown, ctx: ToolContext, signal?: AbortSignal): Promise<ToolResultLike> => {
      const { account_group, ...original } = args as Record<string, unknown>;
      const tool = entries.get(String(account_group));
      if (!tool) return { content: [{ type: "text", text: `Choose a valid account_group: ${[...entries.keys()].join(", ")}` }], isError: true };
      return tool.spec.execute(original, ctx, signal);
    },
  } };
}

/** One session per existing identity, with one routed tool set in the agent. */
export class ComposioFleet {
  readonly allToolkits = true;
  readonly toolkitSlugs = ["*"];
  /** Every group runs in all-toolkits mode, which Composio always serves through the router. */
  readonly mode = "router" as const;
  readonly unavailableToolkits: string[] = [];
  private readonly groups = new Map<string, ComposioApps>();
  private inventory: ConnectionSummary[] = [];
  constructor(private readonly opts: ComposioAppsOptions) {}

  async connect(): Promise<void> {
    if (this.groups.size) return;
    this.inventory = await projectConnections(this.opts.apiKey);
    for (const userId of [...new Set(this.inventory.map(a => a.userId))].sort()) {
      const state = new StateDir(this.opts.state.path("composio-groups", encodeURIComponent(userId)));
      state.ensure();
      const apps = new ComposioApps({ ...this.opts, userId, toolkits: ["*"], multiAccount: true, connectedAccounts: activeAccountsForGroup(this.inventory, userId), state });
      this.groups.set(userId, apps);
    }
    await Promise.all([...this.groups.values()].map(a => a.connect()));
    this.opts.logger?.(`composio: ${this.inventory.length} accounts across ${this.groups.size} identity groups`);
  }

  async tools(): Promise<RegisteredTool[]> {
    await this.connect();
    const byName = new Map<string, Map<string, RegisteredTool>>();
    for (const [group, apps] of this.groups) {
      for (const tool of await apps.tools()) {
        let entries = byName.get(tool.spec.name);
        if (!entries) { entries = new Map(); byName.set(tool.spec.name, entries); }
        entries.set(group, tool);
      }
    }
    const tools = [...byName].map(([name, entries]) => routeTool(name, entries));
    const capabilities = ["apps.use", "trust.manage"] as const;
    tools.push({ spec: {
      name: "apps_accounts", label: "List app accounts and groups",
      description: "List every existing Lupine Composio account, its identity group, ID, toolkit and status. Call before choosing between multiple accounts. Expired accounts need reconnection.",
      parameters: Type.Object({}),
      meta: { capabilities: [...capabilities], group: "apps", describe: () => "list grouped app accounts" },
      execute: async () => { this.inventory = await projectConnections(this.opts.apiKey); return { content: [{ type: "text", text: JSON.stringify(this.inventory) }] }; },
    } });
    tools.push({ spec: {
      name: "apps_connect_group", label: "Connect an app in an account group",
      description: "Get an app sign-in link for a chosen account group. Owner only.",
      parameters: Type.Object({ account_group: Type.String({ enum: [...this.groups.keys()] }), toolkit: Type.String() }),
      meta: { capabilities: [...capabilities], group: "apps", describe: args => `connect app in ${(args as any).account_group}` },
      execute: async (input, ctx) => {
        const args = input as { account_group: string; toolkit: string };
        if (ctx.principal.kind !== "owner") return { content: [{ type: "text", text: "Only the owner can connect apps." }], isError: true };
        const apps = this.groups.get(args.account_group);
        if (!apps) return { content: [{ type: "text", text: "Unknown account group." }], isError: true };
        const link = await apps.connectLink(args.toolkit);
        return { content: [{ type: "text", text: link || "No sign-in required." }] };
      },
    } });
    return tools;
  }

  async connectedToolkits(): Promise<ToolkitStatus[]> {
    return [...new Set(this.inventory.filter(a => a.status === "ACTIVE").map(a => `${a.userId}/${a.toolkit}`))].sort().map(slug => ({ slug, connected: true }));
  }

  async connectLink(_toolkit: string): Promise<string | undefined> {
    throw new Error("Choose an account group with apps_connect_group before connecting an app.");
  }

  async close(): Promise<void> { await Promise.all([...this.groups.values()].map(a => a.close())); this.groups.clear(); }
}
