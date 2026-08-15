import { PRODUCT } from "../product.js";

export function fieldHomeHtml(): string {
  return page({
    title: `${PRODUCT.displayName} · Work`,
    surface: "field",
    body: `
      <header class="top">
        <div class="mark">${PRODUCT.displayName}</div>
        <nav>
          <a class="on" href="/">Work</a>
          <a href="/ask">Ask</a>
        </nav>
      </header>
      <main>
        <p class="lede">Required field path. Continue the open case. Architect controls stay off this screen.</p>
        <section class="card" id="journey">
          <h1>Open case</h1>
          <p class="muted" id="journey-status">Loading…</p>
        </section>
        <section class="card">
          <h2>Next required action</h2>
          <p id="next-action">Complete the packet. Agents will not assume routine follow-up.</p>
        </section>
      </main>
      <script src="/web/field.js"></script>
    `,
  });
}

export function askHtml(): string {
  return page({
    title: `${PRODUCT.displayName} · Ask`,
    surface: "ask",
    body: `
      <header class="top">
        <div class="mark">${PRODUCT.displayName}</div>
        <nav>
          <a href="/">Work</a>
          <a class="on" href="/ask">Ask</a>
        </nav>
      </header>
      <main>
        <p class="lede">Optional Ask. Ceilings come from the loaded pack. Ask cannot raise authority.</p>
        <section class="card">
          <label for="ask-input">Question</label>
          <textarea id="ask-input" rows="5" placeholder="Ask about the open case."></textarea>
          <button id="ask-send" type="button">Send</button>
          <p class="muted" id="ask-ceiling"></p>
          <pre id="ask-out"></pre>
        </section>
      </main>
      <script src="/web/ask.js"></script>
    `,
  });
}

export function architectHtml(): string {
  return page({
    title: `${PRODUCT.displayName} · Architect`,
    surface: "architect",
    body: `
      <header class="top architect">
        <div class="mark">${PRODUCT.displayName} Architect</div>
        <nav>
          <span>Pack</span>
          <span>Org</span>
          <span>Computer</span>
          <span>Policy</span>
        </nav>
      </header>
      <main class="architect-grid">
        <section class="card">
          <h1>Active pack</h1>
          <p class="muted">Signed binding. Field users cannot load or edit packs.</p>
          <pre id="pack-out">No pack loaded.</pre>
        </section>
        <section class="card">
          <h1>Org chart</h1>
          <p class="muted">Count is instance data. There is no product-constant agent N.</p>
          <pre id="org-out"></pre>
        </section>
        <section class="card">
          <h1>Tenant computer</h1>
          <p class="muted">One Linux machine per tenant. Desktops are per-agent. Update keeps the disk.</p>
          <pre id="computer-out"></pre>
        </section>
      </main>
      <script src="/web/architect.js"></script>
    `,
  });
}

function page(input: { title: string; surface: string; body: string }): string {
  return `<!doctype html>
<html lang="en" data-surface="${input.surface}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${input.title}</title>
  <link rel="stylesheet" href="/web/styles.css"/>
</head>
<body>${input.body}</body>
</html>`;
}
