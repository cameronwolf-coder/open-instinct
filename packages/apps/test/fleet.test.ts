import { describe, expect, it } from "vitest";
import { activeAccountsForGroup, projectConnections, routeTool } from "../src/fleet.js";
import type { RegisteredTool, ToolContext } from "@open-instinct/core";

describe("Composio identity routing", () => {
  it("binds every active account in the selected identity and excludes expired or other owners", () => {
    expect(activeAccountsForGroup([
      { id: "one", userId: "work", toolkit: "linear", status: "ACTIVE" },
      { id: "two", userId: "work", toolkit: "linear", status: "ACTIVE" },
      { id: "expired", userId: "work", toolkit: "linear", status: "EXPIRED" },
      { id: "other", userId: "personal", toolkit: "linear", status: "ACTIVE" },
    ], "work")).toEqual({ linear: ["one", "two"] });
  });
  it("reads every inventory page and preserves account ownership and expired status", async () => {
    const requested: string[] = [];
    const fetchImpl = async (url: any) => {
      requested.push(String(url));
      const first = requested.length === 1;
      return new Response(JSON.stringify({ items: [{ id: first ? "one" : "two", user_id: first ? "personal" : "work", toolkit: { slug: "gmail" }, status: first ? "ACTIVE" : "EXPIRED" }], next_cursor: first ? "next-page" : null }));
    };
    expect(await projectConnections("test-key", fetchImpl as typeof fetch)).toEqual([
      { id: "one", userId: "personal", toolkit: "gmail", status: "ACTIVE" },
      { id: "two", userId: "work", toolkit: "gmail", status: "EXPIRED" },
    ]);
    expect(requested[1]).toContain("cursor=next-page");
  });

  it("requires explicit identity and forwards original args only to its selected session", async () => {
    const calls: unknown[] = [];
    const tools = new Map<string, RegisteredTool>();
    for (const group of ["personal", "work"]) tools.set(group, { spec: {
      name: "app_execute", label: "Execute", description: "Test", parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] } as any,
      meta: { capabilities: ["apps.use", "trust.manage"], group: "apps", describe: () => "test" },
      execute: async args => { calls.push({ group, args }); return "ok"; },
    } });
    const routed = routeTool("app_execute", tools);
    expect(routed.spec.parameters.required).toContain("account_group");
    await routed.spec.execute({ account_group: "work", task: "read" }, {} as ToolContext);
    expect(calls).toEqual([{ group: "work", args: { task: "read" } }]);
    const result = await routed.spec.execute({ task: "read" }, {} as ToolContext);
    expect(result).toHaveProperty("isError", true);
    expect(calls).toHaveLength(1);
  });
});
