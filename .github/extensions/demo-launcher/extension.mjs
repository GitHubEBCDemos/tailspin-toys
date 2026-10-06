import { homedir } from "node:os";
import { join } from "node:path";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { Controller, Store } from "./controller.mjs";
import { githubApi, requestCopilotReview } from "./github.mjs";
import { startServer } from "./server.mjs";

const servers = new Map();
const emptyInput = { type: "object", properties: {}, additionalProperties: false };
let session;
const controller = new Controller({
  store: new Store(join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "extensions", "demo-launcher", "artifacts")),
  api: githubApi,
  requestReview: requestCopilotReview,
  send: (options) => session.send(options),
});

session = await joinSession({
  tools: [{
    name: "demo_launcher_receipt",
    description: "Record the verified result of a demo-launcher app-session, feature, issue, or CI handoff. Only call with IDs from its pending prompt, after app tools succeed or fail.",
    parameters: {
      type: "object",
      properties: {
        environmentId: { type: "string" }, requestId: { type: "string" },
        kind: { enum: ["session", "feature", "issue", "ci"] }, status: { enum: ["done", "failed"] },
        projectId: { type: "string" }, sessionId: { type: "string" }, message: { type: "string" },
      },
      required: ["environmentId", "requestId", "kind", "status"],
      additionalProperties: false,
    },
    handler: async (input) => {
      try {
        await controller.receipt(input);
        return "Demo launcher receipt saved.";
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
      description: "Read saved environment receipts without creating repositories, sessions, or prompts.",
      inputSchema: emptyInput,
      handler: () => controller.state(),
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
