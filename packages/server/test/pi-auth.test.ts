import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { piModelRuntime } from "../src/pi-auth.js";

describe("Pi subscription auth", () => {
  it("leaves providers without a stored credential on the existing path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "instinct-auth-"));
    try { expect(await piModelRuntime({ INSTINCT_PI_AUTH_PATH: join(dir, "auth.json") }, "openai-codex")).toBeUndefined(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refreshes expired OAuth and persists it before streaming a response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "instinct-auth-"));
    const authPath = join(dir, "auth.json");
    try {
      writeFileSync(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: "old", refresh: "old-refresh", expires: 0 } }));
      const runtime = (await piModelRuntime({ INSTINCT_PI_AUTH_PATH: authPath }, "openai-codex"))!;
      const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "test-model" }] });
      let refreshes = 0;
      runtime.registerNativeProvider({ ...faux.provider, auth: { oauth: {
        name: "Test subscription", isSubscription: true,
        login: async () => { throw new Error("Unexpected login"); },
        refresh: async credential => { refreshes++; return { ...credential, access: "new", refresh: "new-refresh", expires: Date.now() + 3600000 }; },
        toAuth: async credential => ({ apiKey: credential.access }),
      } } });
      faux.setResponses([(context, options) => {
        expect(options?.apiKey).toBe("new");
        return fauxAssistantMessage("subscription works");
      }]);
      const result = await runtime.completeSimple(faux.getModel(), { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] });
      expect(result.content).toEqual([{ type: "text", text: "subscription works" }]);
      expect(refreshes).toBe(1);
      expect(JSON.parse(readFileSync(authPath, "utf8"))["openai-codex"].refresh).toBe("new-refresh");
      expect((await runtime.getAuth("openai-codex"))?.auth.apiKey).toBe("new");
      expect(refreshes).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
