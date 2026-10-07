import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { Controller, Store } from "./controller.mjs";
import { githubApi, requestCopilotReview } from "./github.mjs";
import { startServer } from "./server.mjs";
import { workspaceRepository } from "./workspace.mjs";
import { openStartupCanvas } from "./startup.mjs";

const servers = new Map();
const emptyInput = { type: "object", properties: {}, additionalProperties: false };
let session;
const directory = fileURLToPath(new URL("../../../", import.meta.url));
const controller = new Controller({
  store: new Store(join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "extensions", "demo-launcher", "artifacts")),
  api: githubApi,
  requestReview: requestCopilotReview,
  send: (options) => session.send(options),
  repo: await workspaceRepository(directory),
  sessionId: () => session.sessionId,
});

session = await joinSession({
  tools: [{
    name: "demo_launcher_receipt",
    description: "Record a pending demo feature, issue, CI, or cleanup result. Only use IDs from its pending prompt, after the requested tools succeed or fail.",
    parameters: {
      type: "object",
      properties: {
        environmentId: { type: "string" }, requestId: { type: "string" },
        kind: { enum: ["feature", "issue", "ci", "cleanup"] }, status: { enum: ["done", "failed"] },
        projectId: { type: "string" }, sessionId: { type: "string" }, message: { type: "string" },
        sessionName: { type: "string" }, removedSessionIds: { type: "array", items: { type: "string" }, uniqueItems: true },
      },
      required: ["environmentId", "requestId", "kind", "status"],
      additionalProperties: false,
    },
    handler: async (input) => {
      try {
        const state = await controller.receipt(input);
        return input.kind === "cleanup" && input.status === "done" ? state.lastCleanup.message : "Demo launcher receipt saved.";
      } catch (error) {
        return { resultType: "failure", textResultForLlm: error.message };
      }
    },
  }, {
    name: "demo_launcher_cleanup_repository",
    description: "Delete the disposable GitHub repository for a confirmed, pending cleanup. Only call from the recorded core session using IDs in its cleanup prompt. Does not delete app sessions or local files.",
    parameters: {
      type: "object", properties: { environmentId: { type: "string" }, requestId: { type: "string" } },
      required: ["environmentId", "requestId"], additionalProperties: false,
    },
    handler: async (input) => {
      try {
        await controller.cleanupRepository(input);
        return "Disposable GitHub repository deleted. Continue removing the confirmed app sessions, then record the cleanup receipt. The local app project still requires manual removal.";
      } catch (error) {
        return { resultType: "failure", textResultForLlm: error.message };
      }
    },
  }],
  canvases: [createCanvas({
    id: "copilot-demos",
    displayName: "Copilot demos",
    description: "Launch Tailspin Toys demos for feature building, Copilot Autofix, issue-to-PR, code review, and failing CI.",
    inputSchema: emptyInput,
    actions: [{
      name: "get_state",
      description: "Read canvas context without mutations. The core shows only in-flight creation; demo instances load their own saved environment.",
      inputSchema: emptyInput,
      handler: () => controller.state(),
    }, {
      name: "bind_session",
      description: "Register this demo session after get_session verifies its repository, project, ID, and name. Enables demo actions and records it for confirmed cleanup.",
      inputSchema: {
        type: "object",
        properties: { repo: { type: "string" }, projectId: { type: "string" }, sessionId: { type: "string" }, sessionName: { type: "string" } },
        required: ["repo", "projectId", "sessionId", "sessionName"], additionalProperties: false,
      },
      handler: async ({ input }) => {
        try {
          return await controller.bindSession(input);
        } catch (error) {
          throw new CanvasError("demo_session_mismatch", error.message);
        }
      },
    }, {
      name: "refresh_status",
      description: "Read CodeQL and PR status for the selected environment; no remote writes.",
      inputSchema: emptyInput,
      handler: async () => {
        try {
          return await controller.refresh();
        } catch (error) {
          throw new CanvasError("demo_status_failed", error.message);
        }
      },
    }],
    open: async ({ instanceId }) => {
      if (!servers.has(instanceId)) servers.set(instanceId, await startServer(controller));
      return { title: "Copilot demos", url: servers.get(instanceId).url };
    },
    onClose: async ({ instanceId }) => {
      const server = servers.get(instanceId);
      servers.delete(instanceId);
      if (server) await server.close();
    },
  })],
});

try {
  await openStartupCanvas({ controller, session, directory });
} catch (error) {
  console.error("Demo canvas automatic startup failed:", error);
  await session.log(`Demo canvas automatic startup failed: ${error.message}`, { level: "error" });
}
