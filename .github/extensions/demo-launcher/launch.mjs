import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { assertOwnedRepository, optional } from "./github.mjs";

export const LAUNCH_BRANCH = "demo/launcher";
export const RUNTIME_FILES = [
  "extension.mjs", "controller.mjs", "github.mjs", "scenarios.mjs", "server.mjs",
  "workspace.mjs", "launch.mjs", "app.js", "index.html", "style.css",
];

export function launchUrl(environment) {
  if (!environment.launcherReady || !environment.launcherMergeCommit) return null;
  const prompt = `Open the Copilot demos canvas (canvasId="copilot-demos") after preparing its extension:
1. In this session's worktree, verify the GitHub origin is ${environment.repo}. The canvas setup was merged into this demo repository's ${environment.defaultBranch} branch and verified at commit ${environment.launcherMergeCommit}. This did not change the source repository or merge any demo PR.
2. Check .github/extensions/demo-launcher/extension.mjs and its sibling runtime files. If the entire demo-launcher directory is absent, fetch origin ${environment.defaultBranch}, verify commit ${environment.launcherMergeCommit} belongs to that branch, and restore ONLY .github/extensions/demo-launcher from that commit into this worktree. Check for tracked deletions or other local edits first; do not overwrite existing work, partially present files, or symlinks. Do not switch branches, modify the main checkout, commit, push, or install software.
3. Call extensions_reload, then extensions_manage with operation="inspect" and name="demo-launcher". Do this even if copilot-demos was absent from the initial canvas catalog. If the provider is failed or missing, report its specific diagnostic/log error; do not create a replacement canvas.
4. Once the provider is running, use list_canvas_capabilities, then open_canvas for copilot-demos. Read its get_state action and verify context.repo="${environment.repo}" and context.kind="demo". Use get_session with the returned context.sessionId to verify this session's repository and project. Call bind_session with repo="${environment.repo}" and the verified projectId, sessionId, and sessionName.
5. Read get_state again to confirm registration and leave the canvas open with the demo controls. Do not create another repository or run a demo automatically.`;
  const values = { repo: environment.repo, branch: environment.defaultBranch, mode: "interactive", prompt };
  const query = Object.entries(values).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `https://github.com/copilot/app/launch?open=${encodeURIComponent(`ghapp://session/new?${query}`)}`;
}

export async function provisionLauncher(environment, { api, save, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (environment.launcherReady && environment.launcherMergeCommit) return;
  const prefix = `repos/${environment.repo}`;
  assertOwnedRepository(environment, await api("GET", prefix));
  delete environment.launcherReady;
  environment.step = "Including the canvas in the demo repository";
  await save();
  const files = await Promise.all(RUNTIME_FILES.map(async (file) => ({
    path: `.github/extensions/demo-launcher/${file}`, mode: "100644", type: "blob",
    content: await readFile(new URL(file, import.meta.url), "utf8"),
  })));
  const message = `demo: include the Copilot launcher\n\nEnvironment: ${environment.id}\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`;
  const existing = await optional(api, `${prefix}/git/ref/heads/${LAUNCH_BRANCH}`);
  if (existing) {
    const commit = await api("GET", `${prefix}/git/commits/${existing.object.sha}`);
    if (commit.message !== message || (environment.launcherCommit && environment.launcherCommit !== existing.object.sha)) {
      throw new Error("The launcher branch was changed or belongs to another operation. It will not be overwritten.");
    }
    environment.launcherCommit = existing.object.sha;
  } else {
    if (!environment.launcherCommit) {
      const base = await api("GET", `${prefix}/git/ref/heads/${encodeURIComponent(environment.defaultBranch)}`);
      const commit = await api("GET", `${prefix}/git/commits/${base.object.sha}`);
      const tree = await api("POST", `${prefix}/git/trees`, {
        base_tree: commit.tree.sha,
        tree: files,
      });
      const launcher = await api("POST", `${prefix}/git/commits`, { message, tree: tree.sha, parents: [base.object.sha] });
      environment.launcherCommit = launcher.sha;
      await save();
    }
    await api("POST", `${prefix}/git/refs`, { ref: `refs/heads/${LAUNCH_BRANCH}`, sha: environment.launcherCommit });
  }
  environment.step = "Verifying the published canvas files";
  await save();
  const ref = await api("GET", `${prefix}/git/ref/heads/${LAUNCH_BRANCH}`);
  if (ref.object.sha !== environment.launcherCommit) {
    throw new Error("The launcher branch no longer points to the published canvas commit. The app session will not be launched.");
  }
  const verifyFiles = async (commit) => {
    const published = await api("GET", `${prefix}/contents/.github/extensions/demo-launcher?ref=${encodeURIComponent(commit)}`);
    for (const { path, content } of files) {
      const sha = createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");
      if (!Array.isArray(published) || !published.some((file) => file.path === path && file.type === "file" && file.sha === sha)) {
        throw new Error(`Published canvas verification failed for ${path}. The app session will not be launched.`);
      }
    }
  };
  await verifyFiles(environment.launcherCommit);

  environment.step = `Merging the canvas setup into the demo repository's ${environment.defaultBranch}`;
  await save();
  const repository = await api("GET", prefix);
  assertOwnedRepository(environment, repository);
  if (repository.default_branch !== environment.defaultBranch || repository.default_branch === LAUNCH_BRANCH) {
    throw new Error("The demo repository's default branch changed. Refusing to merge the canvas setup.");
  }
  const defaultRefPath = `${prefix}/git/ref/heads/${encodeURIComponent(environment.defaultBranch)}`;
  const base = await api("GET", defaultRefPath);
  const changes = await api("GET", `${prefix}/compare/${base.object.sha}...${environment.launcherCommit}`);
  if (!["identical", "behind"].includes(changes.status)) {
    if (!["ahead", "diverged"].includes(changes.status) || !Array.isArray(changes.files) ||
        changes.files.some((file) => !files.some(({ path }) => path === file.filename) || !["added", "modified"].includes(file.status))) {
      throw new Error("The launcher branch includes changes outside the canvas runtime. Refusing to merge it.");
    }
    await api("POST", `${prefix}/merges`, {
      base: environment.defaultBranch,
      head: environment.launcherCommit,
      commit_message: `demo: merge the canvas setup\n\nEnvironment: ${environment.id}\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`,
    });
  }
  environment.step = `Verifying the canvas on the demo repository's ${environment.defaultBranch}`;
  await save();
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const current = await api("GET", defaultRefPath);
    const merged = await api("GET", `${prefix}/compare/${environment.launcherCommit}...${current.object.sha}`);
    if (["identical", "ahead"].includes(merged.status)) {
      await verifyFiles(current.object.sha);
      environment.launcherMergeCommit = current.object.sha;
      environment.launcherReady = true;
      environment.step = "Ready to open in Copilot app";
      await save();
      return;
    }
    if (attempt < 23) await sleep(5_000);
  }
  throw new Error("The canvas merge is not visible on the demo repository's default branch yet. The app session will not be launched.");
}
