import { expect, it, vi } from "vitest";
const listener = vi.hoisted(() => ({
  publicUrl: "https://agent.example",
  serveForever: vi.fn(() => new Promise<void>(() => {})),
  close: vi.fn(async () => {}),
}));
vi.mock("@inkbox/sdk/tunnels/connect", () => ({ connect: vi.fn(async () => listener) }));
import { defaultConnectTunnel } from "../src/commands/dev.js";
it("starts the SDK forwarding loop and closes its listener", async () => {
  const handle = await defaultConnectTunnel({
    apiKey: "test", handle: "agent", forwardTo: "http://127.0.0.1:8080", log: () => {},
  });
  expect(listener.serveForever).toHaveBeenCalledOnce();
  await handle.close();
  expect(listener.close).toHaveBeenCalledOnce();
});
