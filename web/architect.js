async function load() {
  const response = await fetch("/api/architect/packs/load-fixture", {
    method: "POST",
    headers: { "x-av-principal": "architect" },
  });
  const payload = await response.json();
  document.getElementById("pack-out").textContent = JSON.stringify(payload.pack ?? payload, null, 2);
  document.getElementById("org-out").textContent = JSON.stringify(payload.agents ?? payload, null, 2);
}

load().catch((error) => {
  document.getElementById("pack-out").textContent = String(error);
});
