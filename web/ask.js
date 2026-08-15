const out = document.getElementById("ask-out");
const ceiling = document.getElementById("ask-ceiling");
const input = document.getElementById("ask-input");

document.getElementById("ask-send").addEventListener("click", async () => {
  const response = await fetch("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json", "x-av-principal": "field_user" },
    body: JSON.stringify({ text: input.value }),
  });
  const payload = await response.json();
  if (payload.ceilings) {
    ceiling.textContent = `Ceiling ${payload.ceilings.maxTurns} turns · ${payload.ceilings.maxExternalEffects} external effects`;
  }
  out.textContent = JSON.stringify(payload, null, 2);
});
