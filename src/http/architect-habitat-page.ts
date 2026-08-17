import { GLASS, PRODUCT } from "../identity.js";

/**
 * Habitat wizard page (HK-082). Off `/field`. Not a named desktop.
 * Unauthenticated GET may serve this inert shell when Accept is text/html.
 * The page collects an already-issued Architect credential in the browser;
 * subsequent `/architect/*` calls send it as Authorization. The GET does not.
 */
export function wantsArchitectHabitatHtml(accept: string | undefined): boolean {
  const header = accept ?? "";
  return /text\/html/i.test(header) && !/application\/json/i.test(header);
}

export function architectHabitatPageHtml(): string {
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
    input, textarea {
      width: 100%; box-sizing: border-box; padding: 0.5rem;
      border: 1px solid var(--hairline); background: var(--near-black); color: var(--bone);
    }
    input[type="checkbox"] { width: auto; }
    button {
      margin: 0.4rem 0.4rem 0 0; padding: 0.45rem 0.8rem;
      border: 1px solid var(--hairline); background: var(--near-black); color: var(--bone); cursor: pointer;
      font-weight: 400;
    }
    ul { list-style: none; padding: 0; margin: 0; }
    li { border-top: 1px solid var(--hairline); padding: 0.6rem 0; }
    li:first-child { border-top: 0; }
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

    <section class="band" aria-label="Session">
      <h2>Session</h2>
      <label for="token">Issued Architect credential</label>
      <input id="token" autocomplete="off" spellcheck="false" />
      <button id="load" type="button">Load seat</button>
    </section>

    <section class="band" aria-label="Seat">
      <h2>Seat</h2>
      <ul id="org"></ul>
      <ul id="runs"></ul>
      <ul id="workers"></ul>
      <ul id="grants"></ul>
      <p id="eval" class="lead"></p>
      <p id="isolation" class="lead"></p>
    </section>

    <section class="band" aria-label="Adapter">
      <h2>Adapter</h2>
      <label for="model-id">model id</label>
      <input id="model-id" autocomplete="off" spellcheck="false" />
      <label for="vendor-base-url">vendor base URL (optional)</label>
      <input id="vendor-base-url" autocomplete="off" spellcheck="false" />
      <label for="api-key">api key</label>
      <input id="api-key" type="password" autocomplete="off" spellcheck="false" />
      <button id="write-adapter" type="button">Write adapter</button>
    </section>

    <section class="band" aria-label="Connector">
      <h2>Connector</h2>
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
      <button id="write-connector" type="button">Write connector</button>
    </section>
  </main>
  <footer>Alpha Vector LLC</footer>
  <script>
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
    async function writeAdapter() {
      var modelId = document.getElementById("model-id").value.trim();
      var vendorBaseUrl = document.getElementById("vendor-base-url").value.trim();
      var apiKey = document.getElementById("api-key").value.trim();
      if (modelId) {
        await call("/architect/bind-adapter", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(vendorBaseUrl ? { modelId: modelId, vendorBaseUrl: vendorBaseUrl } : { modelId: modelId }),
        });
      }
      if (apiKey) {
        await call("/architect/set-adapter-credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: apiKey }),
        });
      }
      status("adapter written");
    }
    async function writeConnector() {
      var connectorId = document.getElementById("connector-id").value.trim();
      var baseUrl = document.getElementById("base-url").value.trim();
      var secret = document.getElementById("secret").value.trim();
      var requiresCredentials = document.getElementById("requires-credentials").checked;
      if (connectorId) {
        var bind = { connectorId: connectorId, requiresCredentials: requiresCredentials };
        if (baseUrl) bind.baseUrl = baseUrl;
        await call("/architect/bind-connector", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(bind),
        });
      }
      if (connectorId && secret) {
        await call("/architect/set-connector-credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connectorId: connectorId, secret: secret }),
        });
      }
      status("connector written");
    }
    document.getElementById("load").addEventListener("click", function () {
      loadSeat().catch(function (err) { status(err.message); });
    });
    document.getElementById("write-adapter").addEventListener("click", function () {
      writeAdapter().catch(function (err) { status(err.message); });
    });
    document.getElementById("write-connector").addEventListener("click", function () {
      writeConnector().catch(function (err) { status(err.message); });
    });
  </script>
</body>
</html>
`;
}
