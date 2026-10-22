import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
const authPath = process.env.INSTINCT_PI_AUTH_PATH || join(process.env.PI_CODING_AGENT_DIR || getAgentDir(), "auth.json");
const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
const terminal = createInterface({ input: process.stdin, output: process.stdout });
try {
  await runtime.login("openai-codex", "oauth", {
    prompt: async (prompt) => {
      if (prompt.type === "select" && prompt.options?.some(o => o.id === "device_code")) return "device_code";
      return terminal.question(prompt.message + " ");
    },
    notify: event => {
      if (event.type === "device_code") console.log(`Sign in at ${event.verificationUri} with code ${event.userCode}`);
      else if (event.type === "auth_url") console.log(`Sign in: ${event.url}`);
      else if (event.type === "info" || event.type === "progress") console.log(event.message);
    },
  });
  console.log(`Subscription login saved privately to ${authPath}`);
} finally { terminal.close(); }
