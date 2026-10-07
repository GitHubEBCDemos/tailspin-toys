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
let creating = false;
let actionError;
let launchAttempt;
let cleanupConfirmation;

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
  if (state.interfaceVersion !== 4) {
    element("setup").hidden = true;
    element("demos").hidden = true;
    element("cleanup-section").hidden = true;
    showError("Reload extensions or restart this session to load the repository-aware canvas.");
    return;
  }
  const source = state.context.kind === "source";
  const environment = source && !creating
    ? launchAttempt : state.environments.find((item) => item.id === state.activeId);
  const demo = state.context.kind === "demo";
  const linked = environment?.sessions?.some((item) => item.runtimeId === state.context.sessionId);
  const pending = environment?.request?.status === "pending";
  const cleaning = Boolean(environment?.cleanup);
  element("context-summary").textContent = source
    ? "Create a disposable demo repository, approve repository setup, then start its Copilot app session."
    : demo ? `Demo instance: ${state.context.repo}` : `This repository is not a recorded demo instance: ${state.context.repo}`;
  element("setup").hidden = !source;
  element("demos").hidden = !demo || cleaning;
  element("instance-status").hidden = source;
  element("instance-status").textContent = !demo
    ? "No resources will be changed. Open the core Tailspin Toys repository to create a demo instance."
    : cleaning ? "Cleanup is in progress. Continue in the core session."
      : linked ? "Demos run in this repository. Game search uses this session; issue and CI work use separate worktrees."
        : "Waiting for the startup prompt to verify and register this session. Ask Copilot to read the canvas state and bind this session if startup was interrupted.";
  element("environment-info").hidden = !environment;
  element("environment-badge").textContent = creating ? "Creating..." : launchAttempt ? "Review setup first" : "Ready";
  element("create").disabled = busy;
  element("create").setAttribute("aria-busy", String(creating));
  element("create-label").textContent = creating ? "Creating..." : "Create";
  element("create-spinner").hidden = !creating;
  const canStart = Boolean(source && environment?.setupUrl && environment?.launchUrl && !cleaning && !creating);
  element("open-app").hidden = !canStart;
  element("start-session").hidden = !canStart;
  element("approval-instructions").hidden = !canStart;
  if (canStart) {
    element("open-app").href = environment.setupUrl;
    element("start-session").href = environment.launchUrl;
  }
  element("feature").disabled = busy || pending || !demo || !linked || cleaning;
  element("refresh").disabled = busy || !demo || !environment?.prNumber || cleaning;
  element("pr-link").hidden = !environment?.prNumber;
  element("github-links").hidden = !environment?.repo;
  element("cleanup-section").hidden = !demo;
  element("cleanup").disabled = busy || (!source && !linked);
  element("cleanup").textContent = cleaning ? "Retry cleanup" : "Clean up environment";
  element("cleanup-status").textContent = cleaning
    ? environment.request?.status === "pending" ? "Cleanup requested. It is not complete until the core session confirms deletion."
      : environment.request?.message || "Cleanup is incomplete. Check the conversation before retrying."
    : "Requires confirmation of the repository and session names before deleting anything.";
  for (const kind of ["issue", "review", "ci"]) {
    const scenario = environment?.scenarios?.[kind];
    const available = Boolean(demo && !cleaning && scenario?.number);
    const request = environment?.request?.kind === kind ? environment.request : null;
    const defaultStatus = !available
      ? "This demo was not fully provisioned. Check its creation result before presenting."
      : kind === "issue" ? "Ready. Runs in its own worktree and opens a linked PR; nothing is merged."
        : kind === "review" ? "Ready to request a GitHub Copilot review. Requires an eligible Copilot plan; may consume usage."
          : "PR prepared. Check CI to confirm a current unit-test failure before asking Copilot to repair it.";
    element(`${kind}-status`).textContent = request?.status === "pending"
      ? "Handoff requested. Check this conversation for the demo session."
      : [request?.message, scenario?.status?.message].filter(Boolean).join(" ") || defaultStatus;
    element(`run-${kind}`).disabled = busy || pending || !available ||
      (kind !== "review" && !linked) ||
      (kind === "ci" && scenario?.status?.state !== "failed") ||
      (kind === "review" && ["requested", "reviewed"].includes(scenario?.status?.state));
    element(`${kind}-link`).hidden = !available;
    if (available) element(`${kind}-link`).href = `https://github.com/${environment.repo}/${kind === "issue" ? "issues" : "pull"}/${scenario.number}`;
    if (kind !== "issue") element(`check-${kind}`).disabled = busy || !available;
  }
  const ciRun = environment?.scenarios?.ci?.status?.runId;
  element("ci-run-link").hidden = !ciRun;
  if (ciRun) element("ci-run-link").href = `https://github.com/${environment.repo}/actions/runs/${ciRun}`;
  showError(source ? actionError : environment?.error);
  if (!environment) return;

  const url = `https://github.com/${environment.repo}`;
  element("repo-link").textContent = environment.repo;
  element("repo-link").href = url;
  element("setup-status").textContent = environment.step;
  element("actions-link").href = `${url}/actions`;
  element("security-link").href = `${url}/settings/security_analysis`;
  if (environment.prNumber) element("pr-link").href = `${url}/pull/${environment.prNumber}`;
  element("scan-status").textContent = environment.scan?.message || (environment.prNumber
    ? "PR prepared; CodeQL and Copilot Autofix may still be processing. Check readiness before presenting."
    : "The security PR was not fully provisioned. Check the creation result.");
  element("feature-status").textContent = environment.request?.kind === "feature"
    ? (pending ? "Game search is requested in this session..." : environment.request.message || "Feature request failed; check this conversation.")
    : linked ? "Builds game search here, without switching sessions." : "Waiting for this demo session to be registered.";
}

async function act(route, body = {}) {
  if (busy) return;
  let launchWindow;
  const launching = route === "create";
  if (launching) {
    launchAttempt = null;
    state = { ...state, activeId: null, environments: [] };
    // Open during the click gesture; waiting for provisioning would lose popup permission.
    try {
      launchWindow = window.open("about:blank", "_blank");
      if (launchWindow) {
        launchWindow.opener = null;
        launchWindow.document.title = "Preparing Copilot demo";
        launchWindow.document.body.textContent = "Preparing your demo environment. Keep the launcher session open; this tab will open repository setup for your approval when provisioning finishes.";
      }
    } catch (error) {
      element("status").textContent = `Automatic setup navigation is unavailable: ${error.message}. Use Review repository setup after provisioning.`;
    }
  }
  busy = true;
  creating = launching;
  actionError = null;
  showError(null);
  element("status").textContent = launching
    ? "Creating your demo environment. This may take a few minutes; repository setup will open for approval when it is ready."
    : "Working...";
  render();
  try {
    state = await api(route, body);
    const environment = state.environments.find((item) => item.id === state.activeId);
    element("status").textContent = route === "feature" || route === "cleanup" || (route === "scenario" && body.kind !== "review")
      ? "Requested. Follow progress in the conversation." : "Updated.";
    if (launching && environment?.setupUrl && environment?.launchUrl) {
      launchAttempt = environment;
      if (launchWindow && !launchWindow.closed) {
        try {
          launchWindow.location.replace(environment.setupUrl);
          element("status").textContent = "Review and accept repository setup in the app, then return here and select Start demo session. No demo session has been started.";
        } catch (error) {
          element("status").textContent = `Automatic setup navigation failed: ${error.message}. Use Review repository setup, then Start demo session after approval.`;
        }
      } else {
        element("status").textContent = "Environment ready. Use Review repository setup; the automatic setup tab was blocked or closed. After accepting setup, select Start demo session.";
      }
    }
  } catch (error) {
    if (launchWindow && !launchWindow.closed) launchWindow.close();
    element("status").textContent = launching ? "Creation stopped. Another Create starts a new environment." : "";
    // Re-read the receipt: even failed setup may already have created the repo or PR.
    try {
      state = await api("state");
    } catch (readError) {
      error.message += ` Unable to reload receipts: ${readError.message}`;
    }
    actionError = error.message;
    busy = false;
    creating = false;
    render();
    showError(error.message);
    return;
  } finally {
    busy = false;
    creating = false;
  }
  render();
}

element("create").addEventListener("click", () => void act("create"));
element("feature").addEventListener("click", () => void act("feature"));
element("refresh").addEventListener("click", () => void act("refresh"));
for (const button of document.querySelectorAll("[data-scenario]")) {
  button.addEventListener("click", () => void act("scenario", { kind: button.dataset.scenario }));
}
for (const button of document.querySelectorAll("[data-check-scenario]")) {
  button.addEventListener("click", () => void act("scenario-status", { kind: button.dataset.checkScenario }));
}
element("cleanup").addEventListener("click", () => {
  const environment = state.environments.find((item) => item.id === state.activeId);
  const sessions = (environment.cleanup?.sessions || environment.sessions).map(({ id, name }) => ({ id, name }));
  cleanupConfirmation = { confirmRepo: environment.repo, confirmedSessions: sessions, retry: Boolean(environment.cleanup) };
  element("cleanup-repo").textContent = environment.repo;
  element("cleanup-sessions").replaceChildren(...sessions.map(({ name }) => {
    const item = document.createElement("li");
    item.textContent = name;
    return item;
  }));
  element("cleanup-retry-warning").hidden = !environment.cleanup;
  element("cleanup-dialog").returnValue = "cancel";
  element("cleanup-dialog").showModal();
});
element("cleanup-dialog").addEventListener("close", () => {
  if (element("cleanup-dialog").returnValue === "delete") void act("cleanup", cleanupConfirmation);
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
