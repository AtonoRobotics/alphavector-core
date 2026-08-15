const status = document.getElementById("journey-status");

fetch("/api/field/state", { headers: { "x-av-principal": "field_user" } })
  .then((response) => response.json())
  .then((state) => {
    if (state.architectCards && state.architectCards.length > 0) {
      status.textContent = "Surface error: architect cards leaked onto the field path.";
      return;
    }
    if (!state.journeyKinds || state.journeyKinds.length === 0) {
      status.textContent = "No active pack. An architect must load a signed pack before field work starts.";
      return;
    }
    const journey = state.journeyKinds[0];
    status.textContent = `${state.language.journey ?? "case"} · ${journey.label} · stages ${journey.stages.join(" → ")}`;
  })
  .catch(() => {
    status.textContent = "Field state unavailable.";
  });
