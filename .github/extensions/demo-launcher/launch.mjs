import { assertOwnedRepository, TEMPLATE } from "./github.mjs";

export const RUNTIME_FILES = [
  "extension.mjs", "controller.mjs", "github.mjs", "scenarios.mjs", "server.mjs",
  "workspace.mjs", "launch.mjs", "app.js", "index.html", "style.css", "BOOTSTRAP.md",
];
const runtimeDirectory = ".github/extensions/demo-launcher";

export function launchUrl(environment) {
  // Existing receipts pin the default-branch commit under the former merge field.
  const verifiedCommit = environment.launcherVerifiedCommit || environment.launcherMergeCommit;
  if (!environment.launcherReady || !verifiedCommit) return null;
  const prompt = `Open the Copilot demos canvas.
Expected origin: ${environment.repo}; default branch: ${environment.defaultBranch}; verified commit: ${verifiedCommit}.
Read .github/extensions/demo-launcher/BOOTSTRAP.md from that commit using git show (fetch origin ${environment.defaultBranch} only if needed), then follow it to verify, open, and bind the existing canvas. Do not rewrite extension files or reload a working provider.`;
  const values = { repo: environment.repo, branch: environment.defaultBranch, mode: "interactive", prompt };
  const query = Object.entries(values).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `https://github.com/copilot/app/launch?open=${encodeURIComponent(`ghapp://session/new?${query}`)}`;
}

function runtimeManifest(files, description) {
  const manifest = new Map();
  for (const name of RUNTIME_FILES) {
    const path = `${runtimeDirectory}/${name}`;
    const file = Array.isArray(files) && files.find((entry) => entry.path === path);
    if (!file || file.type !== "file" || !/^[a-f0-9]{40}$/.test(file.sha)) {
      throw new Error(`${description} verification failed for ${path}. Publish the complete canvas on ${TEMPLATE}'s default branch before creating demos; no runtime files will be uploaded or merged.`);
    }
    manifest.set(path, file.sha);
  }
  return manifest;
}

export async function verifyLauncher(environment, { api, save }) {
  delete environment.launcherReady;
  delete environment.launcherVerifiedCommit;
  const prefix = `repos/${environment.repo}`;
  const repository = await api("GET", prefix);
  assertOwnedRepository(environment, repository);
  if (repository.default_branch !== environment.defaultBranch) {
    throw new Error("The demo repository's default branch changed. The app session will not be launched.");
  }
  environment.step = "Verifying the published template canvas";
  await save();
  const template = await api("GET", `repos/${TEMPLATE}`);
  if (!template.is_template || template.private || !template.default_branch) {
    throw new Error("The configured source must be a public GitHub template with a default branch.");
  }
  const templateRef = await api("GET", `repos/${TEMPLATE}/git/ref/heads/${encodeURIComponent(template.default_branch)}`);
  const expected = runtimeManifest(
    await api("GET", `repos/${TEMPLATE}/contents/${runtimeDirectory}?ref=${encodeURIComponent(templateRef.object.sha)}`),
    "Published template canvas",
  );
  const defaultRefPath = `${prefix}/git/ref/heads/${encodeURIComponent(environment.defaultBranch)}`;
  const base = await api("GET", defaultRefPath);
  const actual = runtimeManifest(
    await api("GET", `${prefix}/contents/${runtimeDirectory}?ref=${encodeURIComponent(base.object.sha)}`),
    "Inherited demo canvas",
  );
  for (const [path, sha] of expected) {
    if (actual.get(path) !== sha) {
      throw new Error(`Inherited demo canvas verification failed for ${path}. The template may have changed during creation; create a fresh demo after publication finishes. No runtime files will be overwritten.`);
    }
  }
  const currentRepository = await api("GET", prefix);
  assertOwnedRepository(environment, currentRepository);
  const current = await api("GET", defaultRefPath);
  if (currentRepository.default_branch !== environment.defaultBranch || current.object.sha !== base.object.sha) {
    throw new Error("The demo repository's default branch changed during canvas verification. The app session will not be launched.");
  }
  environment.launcherTemplateCommit = templateRef.object.sha;
  environment.launcherVerifiedCommit = base.object.sha;
  environment.launcherReady = true;
  environment.step = "Ready to open in Copilot app";
  await save();
}
