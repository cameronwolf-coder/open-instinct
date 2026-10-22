import { join } from "node:path";
import { getAgentDir, ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";

/** Use Pi's locked credential store so OAuth refresh is persisted, not copied into env. */
export async function piModelRuntime(env: NodeJS.ProcessEnv, provider: string): Promise<ModelRuntime | undefined> {
  const authPath = env.INSTINCT_PI_AUTH_PATH?.trim() || join(env.PI_CODING_AGENT_DIR || getAgentDir(), "auth.json");
  if (!readStoredCredential(provider, authPath)) return undefined;
  return ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
}
