import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { RUNTIME_FILES } from "./launch.mjs";
import { workspaceRepository } from "./workspace.mjs";

export const STARTUP_INSTANCE = "demo-session-panel";
const provider = "project:demo-launcher";
const isDemoCanvas = (canvas) => canvas.extensionId === provider && canvas.canvasId === "copilot-demos";

export async function verifyStartupRuntime(directory, environment) {
  const commit = environment.launcherVerifiedCommit || environment.launcherMergeCommit;
  if (!environment.launcherReady || !/^[a-f0-9]{40}$/.test(commit || "")) {
    throw new Error("Demo canvas startup requires a verified default-branch commit.");
  }
  if ((await workspaceRepository(directory)).toLowerCase() !== environment.repo.toLowerCase()) {
    throw new Error("Demo canvas startup origin does not match its receipt.");
  }
  const git = async (...args) => (await promisify(execFile)("git", ["-C", directory, ...args])).stdout.trim();
  const ref = `refs/remotes/origin/${environment.defaultBranch}`;
  await git("check-ref-format", ref);
  await git("merge-base", "--is-ancestor", commit, ref);
  if (await git("rev-parse", "HEAD") !== await git("rev-parse", ref)) return false;
  for (const path of [".github", ".github/extensions", ".github/extensions/demo-launcher"]) {
    if (!(await lstat(join(directory, path))).isDirectory()) {
      throw new Error(`Demo canvas startup requires a regular directory: ${path}`);
    }
  }
  const changed = await git("diff", "--name-only", commit, "--",
    ...RUNTIME_FILES.map((file) => `.github/extensions/demo-launcher/${file}`));
  if (changed) throw new Error(`Demo canvas startup runtime mismatch: ${changed}. No files were changed.`);
  for (const file of RUNTIME_FILES) {
    const path = `.github/extensions/demo-launcher/${file}`;
    const absolute = join(directory, path);
    if (!(await lstat(absolute)).isFile()) throw new Error(`Demo canvas startup requires a regular file: ${path}`);
    const expected = await git("rev-parse", `${commit}:${path}`);
    if (await git("hash-object", absolute) !== expected) {
      throw new Error(`Demo canvas startup runtime mismatch: ${path}. No files were changed.`);
    }
  }
  return true;
}

export async function openStartupCanvas({ controller, session, directory, verify = verifyStartupRuntime }) {
  const state = await controller.state();
  if (state.context.kind !== "demo") return;
  const environment = state.environments.find((item) => item.id === state.activeId);
  if (!environment) throw new Error("Demo canvas startup receipt is missing.");
  if (environment.cleanup) return;
  const sessions = environment.sessions || [];
  if (sessions.length && !sessions.some((item) => item.runtimeId === session.sessionId)) return;
  if (!await verify(directory, environment)) return;
  const { canvases } = await session.rpc.canvas.list();
  if (!canvases.some(isDemoCanvas)) throw new Error("The demo canvas provider has not registered in this session.");
  const { openCanvases } = await session.rpc.canvas.listOpen();
  const existing = openCanvases.find(isDemoCanvas);
  if (existing) return existing;
  return session.rpc.canvas.open({
    extensionId: provider, canvasId: "copilot-demos", instanceId: STARTUP_INSTANCE, input: {},
  });
}
