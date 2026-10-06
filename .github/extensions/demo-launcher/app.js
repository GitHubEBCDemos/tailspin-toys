(() => {
  const root = document.documentElement;
  const preview = new URLSearchParams(window.location.search).get("clawpilotTheme");
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const isTheme = (value) => value === "light" || value === "dark";
  const syncTheme = () => {
    const host = [root.dataset.colorMode, document.body.dataset.colorMode].find(isTheme);
    root.dataset.theme = host || (isTheme(preview) ? preview : system.matches ? "dark" : "light");
  };
  const observer = new MutationObserver(syncTheme);
  for (const element of [root, document.body]) {
    observer.observe(element, { attributes: true, attributeFilter: ["data-color-mode"] });
  }
  system.addEventListener("change", syncTheme);
  syncTheme();
})();

const element = (id) => document.getElementById(id);
let state;
let busy = false;
let savedOptions = "";

async function api(route, body) {
  const response = await fetch(route, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function showError(message) {
  element("error").textContent = message || "";
  element("error").hidden = !message;
}

function render() {
  if (!state) return;
  const environment = state.environments.find((item) => item.id === state.activeId);
  const pending = environment?.request?.status === "pending";
  const options = JSON.stringify(state.environments.map(({ id, repo }) => ({ id, repo })));
  if (savedOptions !== options) {
    element("environment-picker").replaceChildren(...state.environments.map((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.repo;
      return option;
    }));
    savedOptions = options;
  }
  element("saved-environments").hidden = !environment;
  element("environment-picker").value = state.activeId || "";
  element("environment-picker").disabled = busy;
  element("environment-info").hidden = !environment;
  element("environment-badge").textContent = environment?.sessionId ? "Session linked" : environment ? "Setup in progress" : "Not created";
  element("create").disabled = busy || pending;
  element("resume").disabled = busy || pending;
  element("resume").hidden = !environment || Boolean(environment.githubReady && (!state.scenarioSupport || environment.scenariosReady));
  element("retry-session").disabled = busy;
  element("retry-session").hidden = !environment?.githubReady;
  element("feature").disabled = busy || pending || !environment?.sessionId;
  element("refresh").disabled = busy || !environment?.prNumber;
  element("pr-link").hidden = !environment?.prNumber;
  element("github-links").hidden = !environment?.repo;
  element("scenario-availability").hidden = Boolean(state.scenarioSupport);
  element("scenario-availability").textContent = "The new demos are saved. Restart this session to load the updated extension before running them.";
  for (const kind of ["issue", "review", "ci"]) {
    const scenario = environment?.scenarios?.[kind];
    const available = Boolean(state.scenarioSupport && scenario?.number);
    const request = environment?.request?.kind === kind ? environment.request : null;
    const defaultStatus = !available
      ? "Create an environment or resume setup to prepare this demo."
      : kind === "issue" ? "Ready. Runs in its own worktree and opens a linked PR; nothing is merged."
        : kind === "review" ? "Ready to request a GitHub Copilot review. Requires an eligible Copilot plan; may consume usage."
          : "PR prepared. Check CI to confirm a current unit-test failure before asking Copilot to repair it.";
    element(`${kind}-status`).textContent = request?.status === "pending"
      ? "Handoff requested. Check this conversation for the demo session."
      : [request?.message, scenario?.status?.message].filter(Boolean).join(" ") || defaultStatus;
    element(`run-${kind}`).disabled = busy || pending || !available ||
      (kind !== "review" && !environment.sessionId) ||
      (kind === "ci" && scenario?.status?.state !== "failed") ||
      (kind === "review" && ["requested", "reviewed"].includes(scenario?.status?.state));
    element(`${kind}-link`).hidden = !available;
    if (available) element(`${kind}-link`).href = `https://github.com/${environment.repo}/${kind === "issue" ? "issues" : "pull"}/${scenario.number}`;
    if (kind !== "issue") element(`check-${kind}`).disabled = busy || !available;
  }
  const ciRun = environment?.scenarios?.ci?.status?.runId;
  element("ci-run-link").hidden = !ciRun;
  if (ciRun) element("ci-run-link").href = `https://github.com/${environment.repo}/actions/runs/${ciRun}`;
  if (!environment) return;

  const url = `https://github.com/${environment.repo}`;
  element("repo-link").textContent = environment.repo;
  element("repo-link").href = url;
  element("setup-status").textContent = environment.step;
  element("session-status").textContent = environment.sessionId
    ? "The feature demo will run in the linked demo session, not this source repository."
    : environment.request?.status === "pending"
      ? "App session requested. Check this conversation for progress or permission prompts."
      : "App session not linked. Recover the app handoff after GitHub setup completes.";
  element("actions-link").href = `${url}/actions`;
  element("security-link").href = `${url}/settings/security_analysis`;
  if (environment.prNumber) element("pr-link").href = `${url}/pull/${environment.prNumber}`;
  element("scan-status").textContent = environment.scan?.message || (environment.prNumber
    ? "PR prepared; CodeQL and Copilot Autofix may still be processing. Check readiness before presenting."
    : "The security PR has not been created yet. Finish or resume environment setup.");
  element("feature-status").textContent = environment.request?.kind === "feature"
    ? (pending ? "Prompt queued for delivery through this conversation..." : environment.request.message || "Feature handoff failed; check this conversation.")
    : environment.sessionId ? "Sends the prompt to the demo session and opens it in Copilot app." : "Waiting for the demo app session.";
  showError(environment.error);
}

async function act(route, body = {}) {
  if (busy) return;
  busy = true;
  showError(null);
  element("status").textContent = route === "create" || route === "resume"
    ? "Preparing GitHub. This may take a few minutes; progress is saved so setup can be resumed."
    : "Working...";
  render();
  try {
    state = await api(route, body);
    element("status").textContent = route === "feature" || (route === "scenario" && body.kind !== "review")
      ? "Handoff requested. Watch the conversation for delivery." : "Updated.";
  } catch (error) {
    element("status").textContent = "";
    // Re-read the receipt: even failed setup may already have created the repo or PR.
    try {
      state = await api("state");
    } catch (readError) {
      error.message += ` Unable to reload receipts: ${readError.message}`;
    }
    busy = false;
    render();
    showError(error.message);
    return;
  } finally {
    busy = false;
  }
  render();
}

element("create").addEventListener("click", () => void act("create"));
element("resume").addEventListener("click", () => void act("resume"));
element("feature").addEventListener("click", () => void act("feature"));
element("refresh").addEventListener("click", () => void act("refresh"));
for (const button of document.querySelectorAll("[data-scenario]")) {
  button.addEventListener("click", () => void act("scenario", { kind: button.dataset.scenario }));
}
for (const button of document.querySelectorAll("[data-check-scenario]")) {
  button.addEventListener("click", () => void act("scenario-status", { kind: button.dataset.checkScenario }));
}
element("environment-picker").addEventListener("change", () => void act("select", { environmentId: element("environment-picker").value }));
element("retry-session").addEventListener("click", () => element("recovery-dialog").showModal());
element("recovery-dialog").addEventListener("close", () => {
  if (element("recovery-dialog").returnValue === "recover") void act("retry-session", { confirmRetry: true });
});

async function load() {
  try {
    const response = await fetch("state");
    if (!response.ok) throw new Error(`Unable to load demo receipts (${response.status}).`);
    state = await response.json();
    render();
  } catch (error) {
    showError(error.message);
  }
}

// Poll only local receipts; GitHub requests happen on explicit readiness checks.
void load();
setInterval(() => {
  if (!document.hidden) void load();
}, 2000);

fetch("prompt").then(async (response) => {
  if (!response.ok) throw new Error("Unable to load the demo prompt.");
  element("feature-prompt").textContent = (await response.json()).prompt;
}).catch((error) => showError(error.message));
