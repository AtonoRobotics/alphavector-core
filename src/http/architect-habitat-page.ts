import { GLASS, PRODUCT } from "../identity.js";
import { HABITAT_PROVIDERS, WIZARD_STEPS, type AttachMode } from "./architect-habitat-wizard.js";

/**
 * Habitat wizard page (HK-082). Off `/field`. Not a named desktop.
 * Unauthenticated GET may serve this inert shell when Accept is text/html.
 * The page collects an already-issued Architect credential in the browser;
 * subsequent `/architect/*` calls send it as Authorization. The GET does not.
 *
 * Add path is a stepped wizard. Admin inspects/edits already-bound settings
 * and cannot attach a new model or connector.
 */
export function wantsArchitectHabitatHtml(accept: string | undefined): boolean {
  const header = accept ?? "";
  return /text\/html/i.test(header) && !/application\/json/i.test(header);
}

function providerButtons(mode: AttachMode): string {
  return HABITAT_PROVIDERS.filter((row) => row.mode === mode)
    .map(
      (row) =>
        `<button type="button" class="choice" data-provider="${row.id}" data-mode="${row.mode}"${
          row.bindModelId ? ` data-bind-model-id="${row.bindModelId}"` : ""
        }>${row.label}</button>`,
    )
    .join("");
}

function stepNav(): string {
  return WIZARD_STEPS.map(
    (step, index) =>
      `<li data-step-marker="${step.id}" data-step-index="${index + 1}">${index + 1}. ${step.title}</li>`,
  ).join("");
}

export function architectHabitatPageHtml(): string {
  const subscriptionChoices = providerButtons("subscription");
  const apiChoices = providerButtons("api");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${PRODUCT.appDisplay} habitat</title>
  <style>
    :root {
      --bone: ${GLASS.bone};
      --near-black: ${GLASS.nearBlack};
      --hairline: ${GLASS.hairline};
      color-scheme: dark;
      font-family: ui-sans-serif, system-ui, sans-serif;
      font-weight: 400;
    }
    body { margin: 0; background: var(--near-black); color: var(--bone); }
    main { max-width: 42rem; margin: 0 auto; padding: 1.5rem 1.5rem 0; }
    header { padding-bottom: 0.75rem; border-bottom: 1px solid var(--hairline); }
    h1 { font-size: 1rem; font-weight: 500; margin: 0 0 0.25rem; }
    p.lead { margin: 0; font-size: 0.85rem; }
    .band { padding: 1rem 0; border-bottom: 1px solid var(--hairline); }
    h2 { font-size: 0.85rem; font-weight: 500; margin: 0 0 0.75rem; }
    label { display: block; font-size: 0.8rem; margin: 0.5rem 0 0.2rem; }
    input, textarea, select {
      width: 100%; box-sizing: border-box; padding: 0.5rem;
      border: 1px solid var(--hairline); background: var(--near-black); color: var(--bone);
      font-family: ui-sans-serif, system-ui, sans-serif; font-weight: 400;
    }
    input[type="checkbox"] { width: auto; }
    button {
      margin: 0.4rem 0.4rem 0 0; padding: 0.45rem 0.8rem;
      border: 1px solid var(--hairline); background: var(--near-black); color: var(--bone); cursor: pointer;
      font-weight: 400; font-family: ui-sans-serif, system-ui, sans-serif;
    }
    button.choice[data-selected="true"] { border-color: var(--bone); }
    ol.steps { list-style: none; padding: 0; margin: 0 0 0.75rem; font-size: 0.8rem; }
    ol.steps li { display: inline-block; margin: 0 0.75rem 0.35rem 0; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { border-top: 1px solid var(--hairline); padding: 0.6rem 0; }
    li:first-child { border-top: 0; }
    .field[hidden], .step[hidden], #wizard[hidden], #admin[hidden], #surface-switch[hidden] { display: none; }
    .step[data-held="true"] { border-left: 2px solid #C4A574; padding-left: 0.75rem; }
    #status { min-height: 1.2rem; font-size: 0.9rem; margin: 0.75rem 0; }
    footer { max-width: 42rem; margin: 0 auto; padding: 1rem 1.5rem 1.5rem; font-size: 0.75rem; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${PRODUCT.appDisplay} habitat</h1>
      <p class="lead">Architect sits in the habitat.</p>
    </header>
    <div id="status"></div>
    <nav id="surface-switch" hidden>
      <button id="show-wizard" type="button">Add path</button>
      <button id="show-admin" type="button">Admin</button>
    </nav>

    <section id="wizard" data-path="add" aria-label="Add path">
      <ol class="steps" aria-label="Wizard steps">${stepNav()}</ol>

      <section class="band step" data-wizard-step="session" aria-label="Architect session">
        <h2>1. Architect session</h2>
        <label for="token">Issued Architect credential</label>
        <input id="token" autocomplete="off" spellcheck="false" />
        <button id="session-continue" type="button">Continue</button>
      </section>

      <section class="band step" data-wizard-step="attach-model" hidden aria-label="Attach model">
        <h2>2. Attach model</h2>
        <p class="lead">Choose how to attach a model. Only the fields that choice needs appear.</p>
        <div>
          <button type="button" class="choice" id="mode-subscription" data-mode="subscription">Subscription</button>
          <button type="button" class="choice" id="mode-api" data-mode="api">API</button>
        </div>
        <div id="subscription-providers" class="field" hidden data-providers="subscription">${subscriptionChoices}</div>
        <div id="api-providers" class="field" hidden data-providers="api">${apiChoices}</div>
        <div id="subscription-auth-field" class="field" hidden>
          <label for="subscription-auth">subscription auth</label>
          <input id="subscription-auth" type="password" autocomplete="off" spellcheck="false" />
        </div>
        <div id="model-id-field" class="field" hidden>
          <label for="model-id">model id</label>
          <input id="model-id" autocomplete="off" spellcheck="false" />
        </div>
        <div id="vendor-base-url-field" class="field" hidden>
          <label for="vendor-base-url">vendor base URL</label>
          <input id="vendor-base-url" autocomplete="off" spellcheck="false" />
        </div>
        <div id="api-key-field" class="field" hidden>
          <label for="api-key">api key</label>
          <input id="api-key" type="password" autocomplete="off" spellcheck="false" />
        </div>
        <button id="wizard-bind-adapter" type="button">Attach this model</button>
        <button id="attach-model-continue" type="button">Continue</button>
      </section>

      <section class="band step" data-wizard-step="attach-connector" hidden aria-label="Attach connector">
        <h2>3. Attach connector</h2>
        <label for="connector-id">connector id</label>
        <input id="connector-id" autocomplete="off" spellcheck="false" />
        <label for="base-url">base URL (optional)</label>
        <input id="base-url" autocomplete="off" spellcheck="false" />
        <label for="secret">secret (optional)</label>
        <input id="secret" type="password" autocomplete="off" spellcheck="false" />
        <label for="requires-credentials">
          <input id="requires-credentials" type="checkbox" />
          requires credentials
        </label>
        <button id="wizard-bind-connector" type="button">Attach this connector</button>
        <button id="attach-connector-continue" type="button">Continue</button>
      </section>

      <section class="band step" data-wizard-step="router" hidden aria-label="Model router">
        <h2>4. Model router</h2>
        <p class="lead">How a request chooses among bound models. Architect enters the rules.</p>
        <label for="router-rules">router rules</label>
        <textarea id="router-rules" rows="4" autocomplete="off" spellcheck="false"></textarea>
        <button id="wizard-write-router" type="button">Write router</button>
        <button id="router-continue" type="button">Continue</button>
      </section>

      <section class="band step" data-wizard-step="aggregator" hidden aria-label="Multi-model aggregator">
        <h2>5. Multi-model aggregator</h2>
        <p class="lead">Send a request to more than one bound model and combine results. Architect enters the combine.</p>
        <label for="aggregator-combine">combine</label>
        <input id="aggregator-combine" autocomplete="off" spellcheck="false" />
        <button id="wizard-write-aggregator" type="button">Write aggregator</button>
        <button id="aggregator-continue" type="button">Continue</button>
      </section>

      <section class="band step" data-wizard-step="confirm" hidden aria-label="Confirm">
        <h2>6. Confirm</h2>
        <p id="confirm-summary" class="lead"></p>
      </section>
    </section>

    <section id="admin" data-path="admin" hidden aria-label="Admin">
      <section class="band" aria-label="Seat">
        <h2>Seat</h2>
        <button id="load" type="button">Load seat</button>
        <ul id="org"></ul>
        <ul id="runs"></ul>
        <ul id="workers"></ul>
        <ul id="grants"></ul>
        <p id="eval" class="lead"></p>
        <p id="isolation" class="lead"></p>
      </section>
      <section class="band" aria-label="Bound models">
        <h2>Bound models</h2>
        <p class="lead">Inspect or edit a model already attached. Attach a new model on the add path.</p>
        <label for="admin-model-id">bound model</label>
        <select id="admin-model-id"></select>
        <label for="admin-vendor-base-url">vendor base URL</label>
        <input id="admin-vendor-base-url" autocomplete="off" spellcheck="false" />
        <label for="admin-api-key">api key</label>
        <input id="admin-api-key" type="password" autocomplete="off" spellcheck="false" />
        <button id="admin-edit-adapter" type="button">Save model settings</button>
      </section>
      <section class="band" aria-label="Bound connectors">
        <h2>Bound connectors</h2>
        <p class="lead">Inspect or edit a connector already attached. Attach a new connector on the add path.</p>
        <label for="admin-connector-id">bound connector</label>
        <select id="admin-connector-id"></select>
        <label for="admin-base-url">base URL</label>
        <input id="admin-base-url" autocomplete="off" spellcheck="false" />
        <label for="admin-secret">secret</label>
        <input id="admin-secret" type="password" autocomplete="off" spellcheck="false" />
        <label for="admin-requires-credentials">
          <input id="admin-requires-credentials" type="checkbox" />
          requires credentials
        </label>
        <button id="admin-edit-connector" type="button">Save connector settings</button>
      </section>
      <section class="band" aria-label="Router and aggregator settings">
        <h2>Router and aggregator</h2>
        <label for="admin-router-rules">router rules</label>
        <textarea id="admin-router-rules" rows="4" autocomplete="off" spellcheck="false"></textarea>
        <button id="admin-write-router" type="button">Save router</button>
        <label for="admin-aggregator-combine">combine</label>
        <input id="admin-aggregator-combine" autocomplete="off" spellcheck="false" />
        <button id="admin-write-aggregator" type="button">Save aggregator</button>
      </section>
    </section>
  </main>
  <footer>Alpha Vector LLC</footer>
  <script>
    var STEPS = ["session", "attach-model", "attach-connector", "router", "aggregator", "confirm"];
    var FIELDS = {
      "sub-codex": { subscriptionAuth: "required", apiKey: "hidden", vendorBaseUrl: "hidden", modelId: "hidden" },
      "sub-grok": { subscriptionAuth: "required", apiKey: "hidden", vendorBaseUrl: "hidden", modelId: "hidden" },
      "sub-glm": { subscriptionAuth: "required", apiKey: "hidden", vendorBaseUrl: "hidden", modelId: "hidden" },
      "api-claude": { subscriptionAuth: "hidden", apiKey: "required", vendorBaseUrl: "optional", modelId: "required" },
      "api-codex": { subscriptionAuth: "hidden", apiKey: "required", vendorBaseUrl: "optional", modelId: "required" },
      "api-grok": { subscriptionAuth: "hidden", apiKey: "required", vendorBaseUrl: "optional", modelId: "required" },
      "api-kimi": { subscriptionAuth: "hidden", apiKey: "required", vendorBaseUrl: "optional", modelId: "required" },
      "api-glm": { subscriptionAuth: "hidden", apiKey: "required", vendorBaseUrl: "optional", modelId: "required" },
      "api-generic-openai": { subscriptionAuth: "hidden", apiKey: "optional", vendorBaseUrl: "required", modelId: "required" }
    };
    var state = { step: "session", panel: "wizard", mode: "", provider: "", models: [], connectors: [] };
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, function (ch) {
        if (ch === "&") return "&amp;";
        if (ch === "<") return "&lt;";
        if (ch === ">") return "&gt;";
        if (ch === '"') return "&quot;";
        return "&#39;";
      });
    }
    function token() {
      return document.getElementById("token").value.trim();
    }
    function status(text) {
      document.getElementById("status").textContent = text;
    }
    function renderList(id, rows, html) {
      var el = document.getElementById(id);
      el.innerHTML = rows.length ? rows.map(html).join("") : "";
    }
    async function call(path, opts) {
      var headers = Object.assign({ authorization: "Bearer " + token() }, opts.headers || {});
      var res = await fetch(path, Object.assign({}, opts, { headers: headers }));
      var body = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        throw new Error(body.error || body.message || String(res.status));
      }
      return body;
    }
    function setHeld(stepId) {
      document.querySelectorAll("[data-wizard-step]").forEach(function (el) {
        var id = el.getAttribute("data-wizard-step");
        el.setAttribute("data-held", id === stepId && state.panel === "wizard" ? "true" : "false");
      });
    }
    function showStep(stepId) {
      state.step = stepId;
      document.querySelectorAll("[data-wizard-step]").forEach(function (el) {
        el.hidden = el.getAttribute("data-wizard-step") !== stepId;
      });
      document.getElementById("surface-switch").hidden = stepId === "session" && state.panel === "wizard";
      setHeld(stepId);
    }
    function showPanel(panel) {
      state.panel = panel;
      document.getElementById("wizard").hidden = panel !== "wizard";
      document.getElementById("admin").hidden = panel !== "admin";
      if (panel === "admin") {
        setHeld("");
        loadAdmin().catch(function (err) { status(err.message); });
      } else {
        showStep(state.step === "session" ? "attach-model" : state.step);
      }
    }
    function selectedProvider() {
      return document.querySelector("[data-provider][data-selected='true']");
    }
    function applyAttachFields() {
      var provider = selectedProvider();
      var spec = provider ? FIELDS[provider.getAttribute("data-provider")] : null;
      function show(id, need) {
        var el = document.getElementById(id);
        el.hidden = !need || need === "hidden";
      }
      show("subscription-auth-field", spec && spec.subscriptionAuth);
      show("api-key-field", spec && spec.apiKey);
      show("vendor-base-url-field", spec && spec.vendorBaseUrl);
      show("model-id-field", spec && spec.modelId);
    }
    function wizardModelId() {
      var provider = selectedProvider();
      if (!provider) return "";
      var spec = FIELDS[provider.getAttribute("data-provider")];
      if (spec && spec.modelId !== "hidden") {
        return document.getElementById("model-id").value.trim();
      }
      return provider.getAttribute("data-bind-model-id") || provider.getAttribute("data-provider");
    }
    async function wizardBindAdapter() {
      var provider = selectedProvider();
      if (!provider) throw new Error("Choose a provider");
      var spec = FIELDS[provider.getAttribute("data-provider")];
      var modelId = wizardModelId();
      var vendorBaseUrl = document.getElementById("vendor-base-url").value.trim();
      var apiKey = spec.subscriptionAuth !== "hidden"
        ? document.getElementById("subscription-auth").value.trim()
        : document.getElementById("api-key").value.trim();
      if (spec.modelId === "required" && !modelId) throw new Error("model id is required");
      if (spec.vendorBaseUrl === "required" && !vendorBaseUrl) throw new Error("vendor base URL is required");
      if (spec.apiKey === "required" && !apiKey) throw new Error("api key is required");
      if (spec.subscriptionAuth === "required" && !apiKey) throw new Error("subscription auth is required");
      var bind = { modelId: modelId };
      if (vendorBaseUrl) bind.vendorBaseUrl = vendorBaseUrl;
      await call("/architect/bind-adapter", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bind),
      });
      if (apiKey) {
        await call("/architect/set-adapter-credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: apiKey }),
        });
      }
      state.models.push(modelId);
      status("model attached");
    }
    async function wizardBindConnector() {
      var connectorId = document.getElementById("connector-id").value.trim();
      var baseUrl = document.getElementById("base-url").value.trim();
      var secret = document.getElementById("secret").value.trim();
      var requiresCredentials = document.getElementById("requires-credentials").checked;
      if (!connectorId) throw new Error("connector id is required");
      var bind = { connectorId: connectorId, requiresCredentials: requiresCredentials };
      if (baseUrl) bind.baseUrl = baseUrl;
      await call("/architect/bind-connector", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bind),
      });
      if (secret) {
        await call("/architect/set-connector-credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connectorId: connectorId, secret: secret }),
        });
      }
      state.connectors.push(connectorId);
      status("connector attached");
    }
    async function wizardWriteRouter() {
      var rules = document.getElementById("router-rules").value.trim();
      await call("/architect/set-adapter-router", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rules: rules }),
      });
      status("router written");
    }
    async function wizardWriteAggregator() {
      var combine = document.getElementById("aggregator-combine").value.trim();
      await call("/architect/set-adapter-aggregator", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ combine: combine }),
      });
      status("aggregator written");
    }
    async function loadSeat() {
      var seat = await call("/architect/habitat", {
        headers: { accept: "application/json" },
      });
      renderList("org", seat.org || [], function (row) {
        return "<li>" + escapeHtml(row.name || row.agentId) + "</li>";
      });
      renderList("runs", seat.runs || [], function (row) {
        return "<li>" + escapeHtml(row.goal || row.runId) + "</li>";
      });
      renderList("workers", seat.workers || [], function (row) {
        return "<li>" + escapeHtml(row.workerId) + "</li>";
      });
      renderList("grants", seat.grants || [], function (row) {
        return "<li>" + escapeHtml(row.actionClass || row.grantId) + "</li>";
      });
      document.getElementById("eval").textContent = seat.eval && seat.eval.passed ? "eval passed" : "eval";
      document.getElementById("isolation").textContent =
        seat.isolation && seat.isolation.isolation ? seat.isolation.isolation : "";
      status("seat loaded");
    }
    function fillSelect(id, rows, valueKey) {
      var el = document.getElementById(id);
      el.innerHTML = rows.map(function (row) {
        return "<option value=\\"" + escapeHtml(row[valueKey]) + "\\">" + escapeHtml(row[valueKey]) + "</option>";
      }).join("");
    }
    async function loadAdmin() {
      await loadSeat();
      var binds = await call("/architect/adapter-bind", { headers: { accept: "application/json" } });
      fillSelect("admin-model-id", binds.models || [], "modelId");
      var connectors = await call("/architect/connector-bind", { headers: { accept: "application/json" } });
      fillSelect("admin-connector-id", connectors.connectors || [], "connectorId");
      var router = await call("/architect/adapter-router", { headers: { accept: "application/json" } });
      document.getElementById("admin-router-rules").value = router.rules || "";
      var aggregator = await call("/architect/adapter-aggregator", { headers: { accept: "application/json" } });
      document.getElementById("admin-aggregator-combine").value = aggregator.combine || "";
    }
    async function adminEditAdapter() {
      var modelId = document.getElementById("admin-model-id").value.trim();
      if (!modelId) throw new Error("Admin can edit a bound model only");
      var vendorBaseUrl = document.getElementById("admin-vendor-base-url").value.trim();
      var apiKey = document.getElementById("admin-api-key").value.trim();
      var body = { modelId: modelId };
      if (vendorBaseUrl) body.vendorBaseUrl = vendorBaseUrl;
      await call("/architect/edit-adapter-bind", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (apiKey) {
        await call("/architect/set-adapter-credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: apiKey }),
        });
      }
      status("model settings saved");
    }
    async function adminEditConnector() {
      var connectorId = document.getElementById("admin-connector-id").value.trim();
      if (!connectorId) throw new Error("Admin can edit a bound connector only");
      var baseUrl = document.getElementById("admin-base-url").value.trim();
      var secret = document.getElementById("admin-secret").value.trim();
      var requiresCredentials = document.getElementById("admin-requires-credentials").checked;
      var bind = { connectorId: connectorId, requiresCredentials: requiresCredentials };
      if (baseUrl) bind.baseUrl = baseUrl;
      await call("/architect/edit-connector-bind", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bind),
      });
      if (secret) {
        await call("/architect/set-connector-credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connectorId: connectorId, secret: secret }),
        });
      }
      status("connector settings saved");
    }
    async function adminWriteRouter() {
      await call("/architect/set-adapter-router", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rules: document.getElementById("admin-router-rules").value.trim() }),
      });
      status("router saved");
    }
    async function adminWriteAggregator() {
      await call("/architect/set-adapter-aggregator", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ combine: document.getElementById("admin-aggregator-combine").value.trim() }),
      });
      status("aggregator saved");
    }
    document.getElementById("session-continue").addEventListener("click", function () {
      if (!token()) { status("Issued Architect credential is required"); return; }
      document.getElementById("surface-switch").hidden = false;
      showStep("attach-model");
    });
    document.getElementById("mode-subscription").addEventListener("click", function () {
      state.mode = "subscription";
      document.getElementById("subscription-providers").hidden = false;
      document.getElementById("api-providers").hidden = true;
      document.querySelectorAll("[data-provider]").forEach(function (el) { el.setAttribute("data-selected", "false"); });
      applyAttachFields();
    });
    document.getElementById("mode-api").addEventListener("click", function () {
      state.mode = "api";
      document.getElementById("subscription-providers").hidden = true;
      document.getElementById("api-providers").hidden = false;
      document.querySelectorAll("[data-provider]").forEach(function (el) { el.setAttribute("data-selected", "false"); });
      applyAttachFields();
    });
    document.querySelectorAll("[data-provider]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll("[data-provider]").forEach(function (el) { el.setAttribute("data-selected", "false"); });
        btn.setAttribute("data-selected", "true");
        applyAttachFields();
      });
    });
    document.getElementById("wizard-bind-adapter").addEventListener("click", function () {
      wizardBindAdapter().catch(function (err) { status(err.message); });
    });
    document.getElementById("wizard-bind-connector").addEventListener("click", function () {
      wizardBindConnector().catch(function (err) { status(err.message); });
    });
    document.getElementById("wizard-write-router").addEventListener("click", function () {
      wizardWriteRouter().catch(function (err) { status(err.message); });
    });
    document.getElementById("wizard-write-aggregator").addEventListener("click", function () {
      wizardWriteAggregator().catch(function (err) { status(err.message); });
    });
    document.getElementById("attach-model-continue").addEventListener("click", function () { showStep("attach-connector"); });
    document.getElementById("attach-connector-continue").addEventListener("click", function () { showStep("router"); });
    document.getElementById("router-continue").addEventListener("click", function () { showStep("aggregator"); });
    document.getElementById("aggregator-continue").addEventListener("click", function () {
      document.getElementById("confirm-summary").textContent =
        "Models: " + (state.models.join(", ") || "none") + ". Connectors: " + (state.connectors.join(", ") || "none") + ".";
      showStep("confirm");
    });
    document.getElementById("show-wizard").addEventListener("click", function () { showPanel("wizard"); });
    document.getElementById("show-admin").addEventListener("click", function () { showPanel("admin"); });
    document.getElementById("load").addEventListener("click", function () {
      loadSeat().catch(function (err) { status(err.message); });
    });
    document.getElementById("admin-edit-adapter").addEventListener("click", function () {
      adminEditAdapter().catch(function (err) { status(err.message); });
    });
    document.getElementById("admin-edit-connector").addEventListener("click", function () {
      adminEditConnector().catch(function (err) { status(err.message); });
    });
    document.getElementById("admin-write-router").addEventListener("click", function () {
      adminWriteRouter().catch(function (err) { status(err.message); });
    });
    document.getElementById("admin-write-aggregator").addEventListener("click", function () {
      adminWriteAggregator().catch(function (err) { status(err.message); });
    });
    showStep("session");
  </script>
</body>
</html>
`;
}
