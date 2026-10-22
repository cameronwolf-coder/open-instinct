import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateDir } from "@open-instinct/core";
import { DEFAULT_WEBHOOK_EVENTS } from "@open-instinct/inkbox";
import { ensureWebhookSubscription, readWebhookSecrets, writeWebhookSecrets } from "../src/webhook-setup.js";

type Subscription = { id: string; url: string; eventTypes: string[] };
function fakes(opts: { existing?: Subscription[]; configured?: boolean } = {}) {
  const f = {
    subs: opts.existing ?? [],
    created: [] as Array<{ identityId: string; url: string }>,
    updated: [] as Array<{ id: string; eventTypes: string[]; scope?: string }>,
    minted: 0,
    configured: opts.configured ?? false,
    failCreate: false,
    inkbox: {} as any,
    provisioner: {} as any,
  };
  f.inkbox = {
    getIdentity: async (handle: string) => ({ id: `id_${handle}` }),
    webhooks: { subscriptions: {
      list: async (filters: { agentIdentityId: string; scope?: string }) => {
        expect(filters.scope).toBe("identity");
        return f.subs;
      },
      update: async (id: string, update: { eventTypes: string[]; scope?: string }) => {
        f.updated.push({ id, ...update });
        Object.assign(f.subs.find((s) => s.id === id)!, update);
      },
    } },
  };
  f.provisioner = {
    subscribeWebhooks: async (identityId: string, url: string) => {
      if (f.failCreate) throw new Error("subscription unavailable");
      f.created.push({ identityId, url });
      f.subs.push({ id: "sub_new", url, eventTypes: [...DEFAULT_WEBHOOK_EVENTS] });
      return { subscriptionId: "sub_new" };
    },
    ensureSigningKey: async (_handle: string, options: { knownSigningKey?: string; rotate?: boolean }) => {
      if (f.configured && !options.rotate) {
        if (options.knownSigningKey) return options.knownSigningKey;
        throw new Error("Signing key unavailable");
      }
      f.configured = true;
      f.minted++;
      return "whsec_minted";
    },
  };
  return f;
}

const url = "https://pub.example/webhooks/inkbox";
describe("webhook setup", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "instinct-wh-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips through secrets/webhook.json", () => {
    const state = new StateDir(dir);
    expect(readWebhookSecrets(state)).toEqual({});
    writeWebhookSecrets(state, { identityId: "id_h", subscriptionId: "s", url, signingKey: "k" });
    expect(readWebhookSecrets(state)).toMatchObject({ identityId: "id_h", subscriptionId: "s", url, signingKey: "k" });
  });

  it("creates a subscription and persists its identity-bound signing key", async () => {
    const state = new StateDir(dir);
    const f = fakes({ existing: [{ id: "old", url: "https://other.example/hook", eventTypes: ["message.received"] }] });
    const result = await ensureWebhookSubscription({ adminApiKey: "a", handle: "h", url, state, inkbox: f.inkbox, provisioner: f.provisioner });
    expect(result).toEqual({ subscriptionId: "sub_new", created: true, signingKey: "whsec_minted" });
    expect(f.created).toEqual([{ identityId: "id_h", url }]);
    expect(readWebhookSecrets(state)).toMatchObject({ identityId: "id_h", signingKey: "whsec_minted" });
  });

  it("fills missing event coverage at an existing URL without discarding extra events", async () => {
    const state = new StateDir(dir);
    const f = fakes({ existing: [
      { id: "partial", url, eventTypes: ["imessage.received", "message.sent"] },
      { id: "a2a", url, eventTypes: ["a2a.task.created"] },
    ] });
    const options = { adminApiKey: "a", handle: "h", url, state, inkbox: f.inkbox, provisioner: f.provisioner };
    await ensureWebhookSubscription(options);
    expect(f.created).toHaveLength(0);
    expect(f.updated).toHaveLength(1);
    expect(f.updated[0]).toMatchObject({ id: "partial", scope: "identity" });
    expect(f.updated[0]!.eventTypes).toContain("message.sent");
    expect(f.updated[0]!.eventTypes).not.toContain("a2a.task.created");
    expect(new Set(f.subs.flatMap((s) => s.eventTypes))).toEqual(new Set([...DEFAULT_WEBHOOK_EVENTS, "message.sent"]));
    await ensureWebhookSubscription(options);
    expect(f.updated).toHaveLength(1);
    expect(f.minted).toBe(1);
  });

  it("refuses an unavailable configured key before changing subscriptions", async () => {
    const state = new StateDir(dir);
    const f = fakes({ configured: true });
    await expect(ensureWebhookSubscription({ adminApiKey: "a", handle: "h", url, state, inkbox: f.inkbox, provisioner: f.provisioner })).rejects.toThrow("Signing key unavailable");
    expect(f.created).toHaveLength(0);
    expect(f.updated).toHaveLength(0);
    expect(f.minted).toBe(0);
  });

  it("keeps a newly minted key when subscription creation fails", async () => {
    const state = new StateDir(dir);
    const f = fakes();
    const options = { adminApiKey: "a", handle: "h", url, state, inkbox: f.inkbox, provisioner: f.provisioner };
    f.failCreate = true;
    await expect(ensureWebhookSubscription(options)).rejects.toThrow("subscription unavailable");
    expect(readWebhookSecrets(state).signingKey).toBe("whsec_minted");
    f.failCreate = false;
    await ensureWebhookSubscription(options);
    expect(f.minted).toBe(1);
  });

  it("does not reuse a stored key from another identity", async () => {
    const state = new StateDir(dir);
    writeWebhookSecrets(state, { identityId: "id_other", url, signingKey: "whsec_other" });
    const f = fakes({ configured: true });
    await expect(ensureWebhookSubscription({ adminApiKey: "a", handle: "h", url, state, inkbox: f.inkbox, provisioner: f.provisioner })).rejects.toThrow("Signing key unavailable");
  });

  it("prefers a key supplied by the environment", async () => {
    const state = new StateDir(dir);
    const f = fakes({ configured: true });
    const result = await ensureWebhookSubscription({ adminApiKey: "a", handle: "h", url, state, knownSigningKey: "whsec_env", inkbox: f.inkbox, provisioner: f.provisioner });
    expect(result.signingKey).toBe("whsec_env");
    expect(f.minted).toBe(0);
  });
});
