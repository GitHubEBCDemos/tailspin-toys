import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

export const DEMO_OWNER = "GitHubEBCDemos";
export const TEMPLATE = `${DEMO_OWNER}/tailspin-toys`;
export const UPSTREAM_REPOSITORY = "github-samples/tailspin-toys";
export const SOURCE_REPOSITORIES = [TEMPLATE, UPSTREAM_REPOSITORY];
export const BRANCH = "demo/copilot-autofix";
export const FIXTURE_PATH = "demo-security/preview.mjs";
export const RULE = "js/reflected-xss";

// Text only: this fixture is written exclusively to the disposable PR branch.
export const FIXTURE = [
  "// INTENTIONALLY VULNERABLE: isolated CodeQL / Copilot Autofix demo.",
  "// Never merge, deploy, import into the app, or add a listen() call.",
  "import http from 'node:http';",
  "",
  "export const preview = http.createServer((request, response) => {",
  "  const name = new URL(request.url, 'http://localhost').searchParams.get('name') || 'guest';",
  "  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });",
  "  response.end('<h1>Hello ' + name + '</h1>');",
  "});",
  "",
].join("\n");

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function githubApi(method, path, body) {
  return new Promise((resolve, reject) => {
    const args = ["api", "--hostname", "github.com", "--method", method, path,
      "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"];
    if (body !== undefined) args.push("--input", "-");
    const child = execFile("gh", args, { timeout: 60_000, maxBuffer: 4_000_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
      (error, stdout, stderr) => {
        if (error) {
          const status = Number(stderr.match(/HTTP (\d{3})/)?.[1]) || undefined;
          reject(new GitHubError(`GitHub ${method} ${path}: ${stderr.trim() || error.message}`, status));
          return;
        }
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : null);
        } catch {
          reject(new Error(`GitHub ${method} ${path} returned invalid JSON.`));
        }
      });
    // An early gh exit can close stdin before the JSON is written; its callback reports the error.
    child.stdin.on("error", () => {});
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export async function optional(api, path) {
  try {
    return await api("GET", path);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export function isSourceRepository(repo) {
  return SOURCE_REPOSITORIES.some((source) => source.toLowerCase() === repo.toLowerCase());
}

export async function createDemoRepository(environment, run = promisify(execFile)) {
  if (environment.owner !== DEMO_OWNER || environment.repo !== `${DEMO_OWNER}/${environment.name}` ||
      !/^tailspin-demo-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/.test(environment.name) || environment.visibility !== "internal") {
    throw new Error("Internal demo creation requires a generated repository in the demo organization.");
  }
  try {
    await run("gh", ["repo", "create", environment.repo, "--template", TEMPLATE, "--internal",
      "--description", `Disposable Copilot demo [${environment.id}]`],
    { timeout: 60_000, maxBuffer: 4_000_000, env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" } });
  } catch (error) {
    throw new Error(`GitHub repository creation failed: ${error.stderr?.trim() || error.message}`, { cause: error });
  }
}

export function assertOwnedRepository(environment, repository) {
  if (repository.full_name.toLowerCase() !== environment.repo.toLowerCase() ||
      isSourceRepository(repository.full_name) ||
      repository.description !== `Disposable Copilot demo [${environment.id}]` ||
      repository.fork ||
      (environment.repositoryId && repository.id !== environment.repositoryId)) {
    throw new Error("Repository identity does not match this demo's receipt. Refusing to change it.");
  }
  const actualVisibility = repository.visibility || (repository.private ? "private" : "public");
  const visibility = environment.visibility || "public";
  if (actualVisibility !== visibility) {
    throw new Error(`Repository visibility must be ${visibility} for this demo; received ${actualVisibility}. Refusing to change it.`);
  }
}

export async function pullRequestBody(environment, details = {}) {
  const template = await readFile(new URL("../../PULL_REQUEST_TEMPLATE.md", import.meta.url), "utf8");
  const description = details.description || `**Demo only - never merge or deploy.** This intentionally vulnerable, non-listening Node HTTP fixture is isolated from the static Astro site. It demonstrates CodeQL's \`${RULE}\` alert and Copilot Autofix.`;
  const changes = details.changes || `Adds \`${FIXTURE_PATH}\` only on the demo branch. No dependencies or running server are needed for scanning.`;
  const testing = details.testing || "`npm run test:unit`, `npm run test:e2e`, and `npm run build` were not run by environment provisioning. CodeQL runs asynchronously on this PR; inspect its current results before presenting. Unchecked items below are intentional, not assertions of passing checks.";
  const notes = details.notes || "Wait for CodeQL, review the security annotation and Autofix suggestion, then demonstrate the proposed fix. Availability depends on repository policy and GitHub processing; a suggestion is not guaranteed.";
  return template
    .replace("## Description\n", `## Description\n\n${description}\n`)
    .replace("## Related Issue\n", "## Related Issue\n\nN/A - disposable presentation fixture, not a proposed application change.\n")
    .replace("## Changes Made\n", `## Changes Made\n\n${changes}\n`)
    .replace("## Testing\n", `## Testing\n\n${testing}\n`)
    .replace("## Additional Notes\n", `## Additional Notes\n\n${notes}\n\nProvisioning receipt: \`${environment.id}\`. Keep this PR open for the demo. Delete the disposable repository manually when finished.\n`);
}

export function requestCopilotReview(repo, number) {
  return new Promise((resolve, reject) => {
    execFile("gh", ["pr", "edit", String(number), "--repo", `https://github.com/${repo}`, "--add-reviewer", "@copilot"],
      { timeout: 60_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`Could not request Copilot code review. Requires gh 2.88+ and an eligible Copilot plan/repository policy. ${stderr.trim() || error.message}`, { cause: error }));
        } else {
          resolve();
        }
      });
  });
}

export async function provision(environment, { api, save, createRepository = createDemoRepository, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const checkpoint = async (step) => {
    environment.step = step;
    await save();
  };
  const waitFor = async (read, description) => {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const value = await read();
      if (value) return value;
      await sleep(5_000);
    }
    throw new Error(`${description} is not ready yet. This creation attempt did not finish.`);
  };
  await checkpoint("Checking repository identity");
  const prefix = `repos/${environment.repo}`;
  let repository = await optional(api, prefix);
  if (!repository) {
    if (environment.repositoryId) throw new Error("The recorded repository is missing or inaccessible. It will not be recreated automatically.");
    await checkpoint("Creating internal template repository");
    await createRepository(environment);
    repository = await api("GET", prefix);
  }
  assertOwnedRepository(environment, repository);
  environment.repositoryId = repository.id;
  environment.defaultBranch = repository.default_branch;
  await checkpoint("Waiting for template contents");
  const base = await waitFor(async () => {
    try {
      return await optional(api, `${prefix}/git/ref/heads/${encodeURIComponent(environment.defaultBranch)}`);
    } catch (error) {
      if (error.status === 409) return null;
      throw error;
    }
  }, "Template initialization");

  if (repository.private) {
    const security = repository.security_and_analysis;
    if (!security?.code_security && !security?.advanced_security) {
      throw new Error("Repository security settings are unavailable. Admin or security-manager access is required to enable code scanning.");
    }
    const product = security.code_security ? "code_security" : "advanced_security";
    if (security[product].status !== "enabled") {
      await checkpoint("Enabling repository code security");
      await api("PATCH", prefix, { security_and_analysis: { [product]: { status: "enabled" } } });
      await checkpoint("Waiting for repository code security");
      await waitFor(async () => {
        const current = await api("GET", prefix);
        assertOwnedRepository(environment, current);
        if (!current.security_and_analysis?.[product]) {
          throw new Error("Repository code security readback is unavailable. CodeQL setup has not started.");
        }
        return current.security_and_analysis[product].status === "enabled";
      }, "Repository code security");
    }
  }

  await checkpoint("Configuring CodeQL default setup");
  const setup = await api("GET", `${prefix}/code-scanning/default-setup`);
  if (!environment.setupRunPath && (setup.state !== "configured" || environment.setupFailed)) {
    // Template refs can be ready before GitHub finishes indexing their languages.
    const { update } = await waitFor(async () => {
      try {
        return { update: await api("PATCH", `${prefix}/code-scanning/default-setup`, {
          state: "configured", languages: ["javascript-typescript"], query_suite: "default",
        }) };
      } catch (error) {
        if (error.status !== 422 || !error.message.includes("One or more languages you selected are not present")) throw error;
        await checkpoint("Waiting for GitHub language detection before configuring CodeQL");
        return null;
      }
    }, "GitHub language detection");
    if (update?.run_url) {
      const url = new URL(update.run_url);
      if (url.origin !== "https://api.github.com" || !url.pathname.startsWith(`/${prefix}/`)) {
        throw new Error("CodeQL returned an unexpected setup-run URL.");
      }
      environment.setupRunPath = url.pathname.slice(1);
    }
    environment.setupFailed = false;
    await save();
  }
  if (environment.setupRunPath) {
    await checkpoint("Waiting for CodeQL setup validation");
    await waitFor(async () => {
      // GitHub can return the setup-run URL before Actions makes that run readable.
      const run = await optional(api, environment.setupRunPath);
      if (!run || run.status !== "completed") return null;
      if (run.conclusion !== "success") {
        environment.setupRunPath = null;
        environment.setupFailed = true;
        await save();
        throw new Error(`CodeQL setup validation ended with ${run.conclusion}. Inspect this repository's Actions and permissions.`);
      }
      return run;
    }, "CodeQL setup validation");
    environment.setupRunPath = null;
    await save();
  }
  await checkpoint("Waiting for CodeQL JavaScript/TypeScript configuration");
  await waitFor(async () => {
    const result = await api("GET", `${prefix}/code-scanning/default-setup`);
    return result.state === "configured" && result.languages?.includes("javascript-typescript") ? result : null;
  }, "CodeQL JavaScript/TypeScript default setup");

  await checkpoint("Seeding isolated security branch");
  const branchPath = `${prefix}/git/ref/heads/${BRANCH}`;
  if (!await optional(api, branchPath)) {
    await api("POST", `${prefix}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: base.object.sha });
  }
  const existing = await optional(api, `${prefix}/contents/${FIXTURE_PATH}?ref=${encodeURIComponent(BRANCH)}`);
  if (existing) {
    if (Buffer.from(existing.content, "base64").toString("utf8") !== FIXTURE) {
      throw new Error("The demo fixture was changed. Refusing to overwrite it; create a fresh environment for a repeat demo.");
    }
  } else {
    await api("PUT", `${prefix}/contents/${FIXTURE_PATH}`, {
      branch: BRANCH,
      message: "demo: add isolated Autofix fixture\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>",
      content: Buffer.from(FIXTURE).toString("base64"),
    });
  }

  await checkpoint("Opening demo-only pull request");
  const pulls = await api("GET", `${prefix}/pulls?state=all&head=${encodeURIComponent(`${environment.owner}:${BRANCH}`)}&per_page=100`);
  let pull = pulls.find((item) => item.state === "open" && item.base.ref === environment.defaultBranch);
  if (!pull && pulls.length) throw new Error("This environment's demo PR was closed. Create a fresh environment instead of reopening or duplicating it.");
  if (!pull) {
    pull = await api("POST", `${prefix}/pulls`, {
      title: "Demo only: preview a greeting (Copilot Autofix)",
      head: BRANCH,
      base: environment.defaultBranch,
      body: await pullRequestBody(environment),
    });
  }
  environment.prNumber = pull.number;
  environment.githubReady = true;
  await checkpoint("GitHub environment created");
}

export async function scanStatus(environment, api) {
  const prefix = `repos/${environment.repo}`;
  assertOwnedRepository(environment, await api("GET", prefix));
  const pull = await api("GET", `${prefix}/pulls/${environment.prNumber}`);
  if (pull.state !== "open") return { state: "closed", message: "Demo PR is closed. Create a fresh environment." };
  const ref = encodeURIComponent(`refs/pull/${pull.number}/merge`);
  const [alerts, runs, comments] = await Promise.all([
    api("GET", `${prefix}/code-scanning/alerts?ref=${ref}&state=open&tool_name=CodeQL&per_page=100`),
    api("GET", `${prefix}/actions/runs?event=pull_request&head_sha=${pull.head.sha}&per_page=100`),
    api("GET", `${prefix}/pulls/${pull.number}/comments?per_page=100&sort=created&direction=desc`),
  ]);
  const alert = alerts.find((item) => item.rule.id === RULE && item.most_recent_instance?.location?.path === FIXTURE_PATH);
  const codeqlRuns = runs.workflow_runs.filter((run) => /codeql/i.test(run.name));
  const latest = codeqlRuns.sort((a, b) => b.id - a.id)[0];
  if (alert) {
    const stale = alert.most_recent_instance.commit_sha !== pull.merge_commit_sha &&
      alert.most_recent_instance.commit_sha !== pull.head.sha;
    if (stale) return { state: "stale", message: "Expected XSS alert detected, but analysis is from an older commit. Wait for CodeQL and refresh." };
    const suggestion = comments.find((comment) =>
      comment.user?.login === "github-advanced-security[bot]" &&
      comment.path === FIXTURE_PATH && comment.commit_id === pull.head.sha &&
      /```suggestion\b/.test(comment.body) && /autofix|copilot/i.test(comment.body));
    return suggestion
      ? { state: "ready", message: "Expected XSS alert and a current Copilot Autofix suggestion detected. Open the PR to demonstrate it." }
      : { state: "alert", message: "Expected XSS alert detected. Open the PR for Autofix; suggestion availability is not yet confirmed." };
  }
  if (latest?.conclusion && latest.conclusion !== "success") {
    return { state: "failed", message: `CodeQL run ended with ${latest.conclusion}. Check Actions, permissions, and repository security settings.` };
  }
  if (latest?.conclusion === "success") {
    return { state: "missing", message: "CodeQL completed, but the expected XSS alert is not present yet. Refresh after processing; inspect the PR and Actions if it stays missing." };
  }
  return { state: "pending", message: "Waiting for CodeQL on the demo PR. This can take several minutes; refresh to check." };
}
