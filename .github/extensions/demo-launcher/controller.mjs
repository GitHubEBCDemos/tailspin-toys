import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TEMPLATE, assertOwnedRepository, provision, scanStatus } from "./github.mjs";
import { CI_BRANCH, ciStatus, provisionScenarios, reviewStatus, scenarioIssue } from "./scenarios.mjs";

export const FEATURE_PROMPT = "Add a basic game-title search to the Tailspin Toys home page. Use a labelled search input with case-insensitive filtering, a visible result count, and a helpful no-results message. Keep the existing dark theme and responsive grid. Follow repository guidance, add data-testid attributes and focused tests, and verify the change. Do not commit, push, create an issue or PR, or install software without asking.";

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.path = join(directory, "environments.json");
    this.lockPath = join(directory, "operation.lock");
  }

  async read() {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8"));
      if (state.version !== 1 || !Array.isArray(state.environments)) throw new Error("Unsupported demo receipt format.");
      return state;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, activeId: null, environments: [] };
      throw error;
    }
  }

  async write(state) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  async exclusive(action) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let acquired = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(this.lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
        acquired = true;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const pid = Number(await readFile(this.lockPath, "utf8"));
        if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Incomplete launcher lock: inspect ${this.lockPath} before removing it.`, { cause: error });
        try {
          process.kill(pid, 0);
        } catch (probe) {
          if (probe.code !== "ESRCH") throw probe;
          await rm(this.lockPath);
          continue;
        }
        throw new Error("Another launcher operation is running. Wait for it to finish, then retry.", { cause: error });
      }
    }
    if (!acquired) throw new Error("Could not acquire the launcher lock. Retry.");
    try {
      return await action();
    } finally {
      await rm(this.lockPath);
    }
  }
}

function active(state) {
  const environment = state.environments.find((item) => item.id === state.activeId);
  if (!environment) throw new Error("Create or select a demo environment first.");
  return environment;
}

function requestPrompt(environment, request) {
  const context = `The user clicked the demo launcher's ${request.kind} button. This authorizes only the operation below in ${environment.repo}, not changes to the source template. Operation ID: ${environment.id}; request ID: ${request.id}.`;
  const receipt = `Finish by calling demo_launcher_receipt with environmentId=${environment.id}, requestId=${request.id}, kind=${request.kind}, status=done and the verified projectId/sessionId (for a session request). On failure call that tool with status=failed and a clear message. Do not leave the canvas pending or claim success before the app tools succeed.`;
  if (request.kind === "session") {
    const sessionName = `Tailspin demo ${environment.id.slice(0, 8)}`;
    return `${context}
Use the app tools, not a shell-generated session or invented deep link:
1. Use list_sessions_and_chats and list_projects to recover an existing project and a session named "${sessionName}" (or an older Tailspin demo session) for exactly ${environment.repo}. Verify any candidate with get_session. Do not reuse a source-template session.
2. If missing, use create_project with github_repo="${environment.repo}", then create_session with its project_id, name="${sessionName}", coordinate_with_creator=false, and no kickoff or base_branch. The user explicitly approved cloning this public repo and the existing session.create npm ci hook. Do not perform any additional install, code changes, commits, or PRs.
3. Use get_session to verify the new session's project/repository matches ${environment.repo}. Leave the launcher visible; do not navigate away.
${receipt}`;
  }
  if (request.kind === "issue" || request.kind === "ci") {
    const isIssue = request.kind === "issue";
    const scenario = environment.scenarios[request.kind];
    const url = `https://github.com/${environment.repo}/${isIssue ? "issues" : "pull"}/${scenario.number}`;
    const work = isIssue
      ? `Implement ${url} end to end. Follow the issue's pagination acceptance criteria and repository instructions. Start from the default branch in this issue's isolated worktree, not the feature, security, review or CI demo branch. Run the relevant checks, commit and push this worktree's feature branch, and use the app's create_pull_request tool to open a PR linked to this issue. If such a PR already exists, continue it instead of creating a duplicate. Never commit to the default branch or merge. Do not install additional software without asking.`
      : `Diagnose and repair ${url}. Inspect the failed run https://github.com/${environment.repo}/actions/runs/${scenario.status.runId} and its unit-test logs, reproduce the failure, then fix the implementation and run the existing checks. Do not skip, delete, weaken, or change test expectations, or modify workflow permissions to make CI pass. Commit and push only to the existing ${CI_BRANCH} PR branch; do not create another PR, push the default branch, or merge. Do not install additional software without asking. Report the new Actions result accurately; a local pass is not a verified green remote run.`;
    return `${context}
Use get_session on "${environment.sessionId}" to confirm project "${environment.projectId}" and repository "${environment.repo}" still match. On mismatch, record failure instead of using this source checkout.
Use ${isIssue ? "open_issue_session" : "open_pr_session"} with repo_full_name="${environment.repo}", ${isIssue ? "issue_number" : "pr_number"}=${scenario.number}, coordinate_with_creator=false, and NO kickoff to find or create the item's own worktree session. Do not use the feature demo session for this task.
Use get_session to verify the returned session belongs to this repository and exact ${isIssue ? "issue" : "PR"}. If it is already busy, do not dispatch a duplicate task; report that status.
Then send_session_message to that verified item session with delivery_mode="immediate", mode="interactive", and this message:
${work}
${receipt}
Record done only after delivery, not after implementation. Navigate to the item session after recording the receipt. Never implement this task in the launcher/source repository.`;
  }
  return `${context}
First use get_session on "${environment.sessionId}" and verify it belongs to project "${environment.projectId}" and repository "${environment.repo}". If missing, archived, or mismatched, report failure; do not fall back to this session or a different repository.
Use send_session_message with session_id="${environment.sessionId}", delivery_mode="immediate", mode="interactive" and this exact message:
${FEATURE_PROMPT}
${receipt}
Record done only after the message is delivered (this means dispatched, not that the feature is implemented). Then navigate_to that session. Never implement the feature in the launcher/source repository.`;
}

export class Controller {
  constructor({ store, api, send, sleep, requestReview }) {
    this.store = store;
    this.api = api;
    this.send = send;
    this.sleep = sleep;
    this.requestReview = requestReview;
  }

  async state() {
    return { ...await this.store.read(), scenarioSupport: true };
  }

  async mutate(action) {
    return this.store.exclusive(async () => {
      const state = await this.store.read();
      const save = () => this.store.write(state);
      try {
        await action(state, save);
      } catch (error) {
        const environment = state.environments.find((item) => item.id === state.activeId);
        if (environment) {
          environment.error = error.message;
          await save();
        }
        throw error;
      }
      return { ...state, scenarioSupport: true };
    });
  }

  async create() {
    return this.mutate(async (state, save) => {
      const user = await this.api("GET", "user");
      if (!/^[a-zA-Z0-9-]+$/.test(user.login)) throw new Error("Invalid GitHub account name.");
      const template = await this.api("GET", `repos/${TEMPLATE}`);
      if (!template.is_template || template.private) throw new Error("The configured source must be a public GitHub template.");
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const name = `tailspin-demo-${createdAt.slice(0, 10)}-${id.slice(0, 8)}`;
      const environment = {
        id, name, owner: user.login, repo: `${user.login}/${name}`,
        createdAt, step: "Starting", githubReady: false,
      };
      state.environments.push(environment);
      state.activeId = environment.id;
      await save();
      await provision(environment, { api: this.api, save, sleep: this.sleep });
      await provisionScenarios(environment, { api: this.api, save });
      await this.request(environment, "session", save);
    });
  }

  async resume() {
    return this.mutate(async (state, save) => {
      const environment = active(state);
      environment.error = null;
      const user = await this.api("GET", "user");
      if (user.login.toLowerCase() !== environment.owner.toLowerCase()) throw new Error("Sign in to the GitHub account that created this environment before resuming.");
      if (!environment.githubReady) {
        await provision(environment, { api: this.api, save, sleep: this.sleep });
      } else {
        assertOwnedRepository(environment, await this.api("GET", `repos/${environment.repo}`));
      }
      if (!environment.scenariosReady) await provisionScenarios(environment, { api: this.api, save });
      if (!environment.sessionId && environment.request?.status !== "pending") {
        await this.request(environment, "session", save);
      }
    });
  }

  async request(environment, kind, save) {
    if (environment.request?.status === "pending") throw new Error("A Copilot handoff is pending. Check the conversation before retrying.");
    const request = { id: randomUUID(), kind, status: "pending", at: new Date().toISOString() };
    environment.request = request;
    environment.error = null;
    await save();
    try {
      request.messageId = await this.send({ prompt: requestPrompt(environment, request), mode: "immediate" });
      await save();
    } catch (error) {
      request.status = "failed";
      throw error;
    }
  }

  async retrySession({ confirmRetry }) {
    if (confirmRetry !== true) throw new Error("Confirm that you checked the conversation before retrying the session handoff.");
    return this.mutate(async (state, save) => {
      const environment = active(state);
      if (!environment.githubReady) throw new Error("Resume GitHub setup first.");
      assertOwnedRepository(environment, await this.api("GET", `repos/${environment.repo}`));
      if (environment.request) environment.request.status = "superseded";
      // Recovery deliberately reuses existing app resources; stale receipts cannot overwrite this request.
      await this.request(environment, "session", save);
    });
  }

  async feature() {
    return this.mutate(async (state, save) => {
      const environment = active(state);
      if (!environment.sessionId || !environment.projectId) throw new Error("Wait for the demo app session to be linked first.");
      await this.request(environment, "feature", save);
    });
  }

  async scenario({ kind }) {
    if (!["issue", "review", "ci"].includes(kind)) throw new Error("Unknown demo scenario.");
    return this.mutate(async (state, save) => {
      const environment = active(state);
      if (environment.request?.status === "pending") throw new Error("A Copilot handoff is pending. Check the conversation first.");
      if (!environment.scenarios?.[kind]) throw new Error("Resume setup to prepare the additional demos.");
      const scenario = environment.scenarios[kind];
      if (kind === "review") {
        const status = await reviewStatus(environment, this.api);
        if (status.state === "available" && scenario.requestedHead !== status.head) {
          await this.requestReview(environment.repo, scenario.number);
          scenario.requestedHead = status.head;
        }
        scenario.status = status.state === "available"
          ? { ...status, state: "requested", message: "Copilot review requested. Open the PR or check for feedback; generation can take several minutes." }
          : status;
        environment.error = null;
        await save();
        return;
      }
      if (!environment.sessionId || !environment.projectId) throw new Error("Wait for the demo app session to be linked first.");
      if (kind === "issue") {
        await scenarioIssue(environment, this.api);
      } else {
        scenario.status = await ciStatus(environment, this.api);
        await save();
        if (scenario.status.state !== "failed") throw new Error(scenario.status.message);
      }
      await this.request(environment, kind, save);
    });
  }

  async refreshScenario({ kind }) {
    if (!["review", "ci"].includes(kind)) throw new Error("Unknown status scenario.");
    return this.mutate(async (state, save) => {
      const environment = active(state);
      const scenario = environment.scenarios?.[kind];
      if (!scenario) throw new Error("Resume setup to prepare the additional demos.");
      scenario.status = { state: "checking", message: "Checking GitHub..." };
      await save();
      try {
        scenario.status = await (kind === "review" ? reviewStatus : ciStatus)(environment, this.api);
        environment.error = null;
      } catch (error) {
        scenario.status = { state: "unavailable", message: error.message };
        throw error;
      } finally {
        await save();
      }
    });
  }

  async receipt(input) {
    return this.mutate(async (state, save) => {
      const environment = state.environments.find((item) => item.id === input.environmentId);
      const request = environment?.request;
      if (!request || request.id !== input.requestId || request.kind !== input.kind || request.status !== "pending") {
        throw new Error("Stale or mismatched demo receipt. No session was linked.");
      }
      if (!["done", "failed"].includes(input.status)) throw new Error("Receipt status must be done or failed.");
      if (input.status === "done" && input.kind === "session") {
        const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id);
        if (!validId(input.projectId) || !validId(input.sessionId)) throw new Error("A verified app project ID and session ID are required.");
        environment.projectId = input.projectId;
        environment.sessionId = input.sessionId;
      }
      request.status = input.status;
      request.message = input.message || (input.status === "failed"
        ? "Copilot could not complete the handoff. Check this conversation and recover the app session."
        : input.kind === "session" ? "Demo app session linked." : "Demo prompt delivered to its app session.");
      environment.error = input.status === "failed" ? request.message : null;
      await save();
    });
  }

  async refresh() {
    return this.mutate(async (state, save) => {
      const environment = active(state);
      if (!environment.prNumber) throw new Error("The security PR has not been created yet. Resume setup.");
      environment.scan = { state: "checking", message: "Checking GitHub..." };
      await save();
      try {
        environment.scan = await scanStatus(environment, this.api);
        environment.scan.checkedAt = new Date().toISOString();
        environment.error = null;
      } catch (error) {
        environment.scan = { state: "unavailable", message: error.message };
        throw error;
      } finally {
        await save();
      }
    });
  }

  async select({ environmentId }) {
    return this.mutate(async (state, save) => {
      if (!state.environments.some((item) => item.id === environmentId)) throw new Error("Unknown demo environment.");
      state.activeId = environmentId;
      await save();
    });
  }
}
