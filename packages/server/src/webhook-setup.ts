/**
 * Self-hosted mode: the agent exposes itself through an Inkbox tunnel and must
 * make sure Inkbox posts events to that public URL. Idempotent: an existing
 * subscription for the same URL is reused. The signing key is kept under the
 * state dir because Inkbox shows it only once.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Inkbox } from "@inkbox/sdk";
import type { StateDir } from "@open-instinct/core";
import { DEFAULT_WEBHOOK_EVENTS, InkboxProvisioner } from "@open-instinct/inkbox";

export interface WebhookSecrets {
  identityId?: string;
  subscriptionId?: string;
  url?: string;
  signingKey?: string;
  updatedAt?: string;
}

export const WEBHOOK_SECRETS_FILE = ["secrets", "webhook.json"] as const;

export function readWebhookSecrets(state: StateDir): WebhookSecrets {
  try {
    return JSON.parse(readFileSync(state.path(...WEBHOOK_SECRETS_FILE), "utf8")) as WebhookSecrets;
  } catch {
    return {};
  }
}

export function writeWebhookSecrets(state: StateDir, secrets: WebhookSecrets): void {
  const file = state.path(...WEBHOOK_SECRETS_FILE);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ ...secrets, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

export interface EnsureWebhookOptions {
  adminApiKey: string;
  handle: string;
  identityId?: string;
  url: string;
  state: StateDir;
  /** Reuse this key when the identity has one configured, unless rotation is requested. */
  knownSigningKey?: string;
  rotateSigningKey?: boolean;
  baseUrl?: string;
  logger?: (m: string) => void;
  /** Test seams. */
  inkbox?: Pick<Inkbox, "getIdentity" | "webhooks">;
  provisioner?: Pick<InkboxProvisioner, "subscribeWebhooks" | "ensureSigningKey">;
}

export interface EnsureWebhookResult {
  subscriptionId: string;
  created: boolean;
  signingKey?: string;
}

export async function ensureWebhookSubscription(opts: EnsureWebhookOptions): Promise<EnsureWebhookResult> {
  const log = opts.logger ?? (() => {});
  const inkbox = opts.inkbox ?? new Inkbox({ apiKey: opts.adminApiKey, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) });
  const provisioner =
    opts.provisioner ?? new InkboxProvisioner({ adminApiKey: opts.adminApiKey, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) });

  const identityId = opts.identityId ?? (await inkbox.getIdentity(opts.handle)).id;
  const stored = readWebhookSecrets(opts.state);
  const storedForIdentity = stored.identityId === identityId || (!stored.identityId && stored.url === opts.url);
  const signingKey = await provisioner.ensureSigningKey(opts.handle, {
    knownSigningKey: opts.knownSigningKey ?? (storedForIdentity ? stored.signingKey : undefined),
    rotate: opts.rotateSigningKey,
  });
  // Persist one-time keys before any later request can fail.
  writeWebhookSecrets(opts.state, { identityId, url: opts.url, signingKey });

  const matching = (await inkbox.webhooks.subscriptions.list({ agentIdentityId: identityId, scope: "identity" })).filter((s) => s.url === opts.url);
  const existing = matching[0];
  let subscriptionId: string;
  let created = false;
  if (existing) {
    subscriptionId = existing.id;
    const covered = new Set(matching.flatMap((s) => s.eventTypes));
    const missing = DEFAULT_WEBHOOK_EVENTS.filter((event) => !covered.has(event));
    if (missing.length) {
      await inkbox.webhooks.subscriptions.update(existing.id, {
        eventTypes: [...new Set([...existing.eventTypes, ...missing])],
        scope: "identity",
      });
    }
    log(`webhook subscription ${subscriptionId} already points at ${opts.url}`);
  } else {
    const sub = await provisioner.subscribeWebhooks(identityId, opts.url);
    subscriptionId = sub.subscriptionId;
    created = true;
    log(`webhook subscription ${subscriptionId} created for ${opts.url}`);
  }

  writeWebhookSecrets(opts.state, { identityId, subscriptionId, url: opts.url, signingKey });
  return { subscriptionId, created, signingKey };
}
