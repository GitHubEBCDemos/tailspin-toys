import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Controller, Store } from "./controller.mjs";
import { BRANCH, FIXTURE_PATH, GitHubError, TEMPLATE } from "./github.mjs";
import { RUNTIME_FILES } from "./launch.mjs";

export async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), "copilot-demos-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const messages = [];
  const remote = {
    repository: null, branch: null, fixture: null, pulls: [], configured: false,
    alerts: [], workflow_runs: [], comments: [], initializationDelays: 0,
    failure: null, setupRun: null, languageDelays: 0,
    branches: new Map(), files: new Map(), issues: [], nextNumber: 1,
    ciRuns: [], ciJobs: [], reviewUsers: [], reviews: [], reviewRequests: [],
    mainSha: "base-sha", templateSha: "template-sha", runtimeFiles: [],
    templateFiles: await Promise.all(RUNTIME_FILES.map(async (file) => {
      const content = await readFile(new URL(file, import.meta.url), "utf8");
      return {
        path: `.github/extensions/demo-launcher/${file}`, type: "file",
        sha: createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex"),
      };
    })),
  };
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (remote.failure) {
      const error = remote.failure(method, path, body);
      if (error) throw error;
    }
    if (method === "GET" && path === "user") return { login: "presenter" };
    if (method === "GET" && path === `repos/${TEMPLATE}`) return { is_template: true, private: false, default_branch: "main" };
    if (method === "GET" && path === `repos/${TEMPLATE}/git/ref/heads/main`) return { object: { sha: remote.templateSha } };
    if (method === "GET" && path === `repos/${TEMPLATE}/contents/.github/extensions/demo-launcher?ref=${remote.templateSha}`) {
      return remote.templateFiles.map((file) => ({ ...file }));
    }
    if (method === "POST" && path === `repos/${TEMPLATE}/generate`) {
      remote.repository = { id: 101, full_name: `${body.owner}/${body.name}`, description: body.description, default_branch: "main", private: body.private, fork: false };
      remote.branch = null;
      remote.fixture = null;
      remote.configured = false;
      remote.pulls = [];
      remote.issues = [];
      remote.branches.clear();
      remote.files.clear();
      remote.nextNumber = 1;
      remote.mainSha = "base-sha";
      remote.runtimeFiles = remote.templateFiles.map((file) => ({ ...file }));
      return remote.repository;
    }
    const prefix = `repos/${remote.repository?.full_name || "presenter/demo-fresh"}`;
    if (method === "GET" && path === prefix) {
      if (!remote.repository) throw new GitHubError("Not found", 404);
      return remote.repository;
    }
    if (method === "DELETE" && path === prefix) {
      remote.repository = null;
      return null;
    }
    if (method === "GET" && path === `${prefix}/git/ref/heads/main`) {
      if (remote.initializationDelays-- > 0) throw new GitHubError("Empty repository", 409);
      return { object: { sha: remote.mainSha } };
    }
    if (path === `${prefix}/code-scanning/default-setup`) {
      if (method === "PATCH") {
        if (remote.languageDelays-- > 0) throw new GitHubError("One or more languages you selected are not present in the repository.", 422);
        remote.configured = true;
        if (remote.setupRun) return { run_url: `https://api.github.com/${prefix}/actions/runs/42` };
      }
      return { state: remote.configured ? "configured" : "not-configured", languages: ["javascript-typescript"] };
    }
    if (method === "GET" && path === `${prefix}/actions/runs/42`) return remote.setupRun;
    if (method === "GET" && path === `${prefix}/git/ref/heads/${BRANCH}`) {
      if (!remote.branch) throw new GitHubError("Not found", 404);
      return remote.branch;
    }
    if (method === "GET" && path.startsWith(`${prefix}/git/ref/heads/`)) {
      const branch = path.slice(`${prefix}/git/ref/heads/`.length);
      const result = remote.branches.get(branch);
      if (!result) throw new GitHubError("Not found", 404);
      return result;
    }
    if (method === "POST" && path === `${prefix}/git/refs`) {
      const result = { object: { sha: body.sha } };
      remote.branches.set(body.ref.slice("refs/heads/".length), result);
      if (body.ref === `refs/heads/${BRANCH}`) remote.branch = result;
      return result;
    }
    if (method === "GET" && path.startsWith(`${prefix}/contents/${FIXTURE_PATH}?`)) {
      if (!remote.fixture) throw new GitHubError("Not found", 404);
      return { content: remote.fixture };
    }
    if (method === "PUT" && path === `${prefix}/contents/${FIXTURE_PATH}`) {
      remote.fixture = body.content;
      return { commit: { sha: "head-sha" } };
    }
    if (method === "GET" && path.startsWith(`${prefix}/contents/.github/extensions/demo-launcher?ref=`)) {
      const ref = new URL(`https://api.github.com/${path}`).searchParams.get("ref");
      if (ref !== remote.mainSha) throw new GitHubError("Commit not found", 404);
      return remote.runtimeFiles.map((file) => ({ ...file }));
    }
    if (path.startsWith(`${prefix}/contents/`)) {
      const url = new URL(`https://api.github.com/${path}`);
      const file = url.pathname.slice(`/${prefix}/contents/`.length);
      const key = `${body?.branch || url.searchParams.get("ref")}:${file}`;
      if (method === "PUT") {
        remote.files.set(key, body.content);
        return { commit: { sha: "fixture-sha" } };
      }
      const content = remote.files.get(key);
      if (!content) throw new GitHubError("Not found", 404);
      return { content };
    }
    if (method === "GET" && path.startsWith(`${prefix}/pulls?`)) {
      const branch = new URL(`https://api.github.com/${path}`).searchParams.get("head").split(":")[1];
      return remote.pulls.filter((pull) => pull.head.ref === branch);
    }
    if (method === "POST" && path === `${prefix}/pulls`) {
      const number = remote.nextNumber++;
      const pull = {
        number, state: "open", body: body.body, title: body.title, base: { ref: body.base },
        head: { sha: number === 1 ? "head-sha" : `head-sha-${number}`, ref: body.head, repo: { full_name: remote.repository.full_name } },
        merge_commit_sha: "merge-sha",
      };
      remote.pulls.push(pull);
      return pull;
    }
    if (method === "POST" && path === `${prefix}/issues`) {
      const issue = { number: remote.nextNumber++, state: "open", body: body.body, title: body.title, user: { login: "presenter" } };
      remote.issues.push(issue);
      return issue;
    }
    if (method === "GET" && path.startsWith(`${prefix}/issues?`)) {
      const creator = new URL(`https://api.github.com/${path}`).searchParams.get("creator");
      return remote.issues.filter((issue) => !creator || issue.user.login === creator);
    }
    if (method === "GET" && path.startsWith(`${prefix}/issues/`)) return remote.issues.find((issue) => path === `${prefix}/issues/${issue.number}`);
    if (method === "GET" && /\/pulls\/\d+$/.test(path)) return remote.pulls.find((pull) => path === `${prefix}/pulls/${pull.number}`);
    if (method === "GET" && path.endsWith("/requested_reviewers")) return { users: remote.reviewUsers };
    if (method === "GET" && path.includes("/reviews?")) return remote.reviews;
    if (method === "GET" && path.includes("/actions/workflows/run-tests.yml/runs?")) return { workflow_runs: remote.ciRuns };
    if (method === "GET" && /\/actions\/runs\/\d+\/jobs\?/.test(path)) return { jobs: remote.ciJobs };
    if (method === "GET" && path.startsWith(`${prefix}/code-scanning/alerts?`)) return remote.alerts;
    if (method === "GET" && path.startsWith(`${prefix}/actions/runs?`)) return { workflow_runs: remote.workflow_runs };
    if (method === "GET" && path.startsWith(`${prefix}/pulls/1/comments?`)) return remote.comments;
    if (method === "GET" && /^repos\/[^/]+\/[^/]+$/.test(path)) throw new GitHubError("Not found", 404);
    throw new Error(`Unexpected fake GitHub request: ${method} ${path}`);
  };
  const store = new Store(directory);
  const makeController = (repo = TEMPLATE, runtimeId = "source-session") => new Controller({
    store, api, sleep: async () => {},
    repo, sessionId: () => runtimeId,
    send: async (options) => {
      messages.push(options);
      return `message-${messages.length}`;
    },
    requestReview: async (repo, number) => {
      remote.reviewRequests.push({ repo, number });
      remote.reviewUsers = [{ login: "copilot-pull-request-reviewer[bot]", type: "Bot" }];
    },
  });
  const source = makeController();
  let controller = source;
  const create = () => source.create();
  const current = async () => (await store.read()).environments.at(-1);
  const link = async () => {
    const environment = await current();
    controller = makeController(environment.repo, "demo-session");
    return controller.bindSession({ repo: environment.repo, projectId: "demo-project", sessionId: "demo-session", sessionName: "Demo control room" });
  };
  return { get controller() { return controller; }, source, makeController, store, api, remote, messages, calls, create, current, link };
}
