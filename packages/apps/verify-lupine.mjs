import { readFileSync } from "node:fs";
import { Composio } from "@composio/core";
const saved = JSON.parse(readFileSync(new URL("../../.instinct/secrets/composio.json", import.meta.url), "utf8"));
const c = new Composio({ apiKey: saved.apiKey });
try {
  let cursor;
  const accounts = [];
  do {
    const page = await c.connectedAccounts.list({ userIds: [saved.userId], ...(cursor ? { cursor } : {}) });
    accounts.push(...page.items.map(a => ({ id: a.id, toolkit: a.toolkit.slug, status: a.status })));
    cursor = page.nextCursor;
  } while (cursor);
  console.log(JSON.stringify({ userId: saved.userId, accounts }));
} catch (e) {
  console.log(String(e.message).replaceAll(saved.apiKey, "[redacted]"));
  process.exitCode = 1;
}
