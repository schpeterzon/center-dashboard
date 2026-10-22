export const ATMOSPHERES = Object.freeze({
  phosphor: {
    accent: [217, 236, 167],
    background: "#101210",
    neutral: [143, 149, 143],
    warning: [236, 185, 107],
    error: [235, 133, 143],
    success: [153, 210, 154],
  },
  glacier: {
    accent: [165, 217, 246],
    background: "#0e141a",
    neutral: [145, 151, 158],
    warning: [236, 185, 107],
    error: [241, 141, 156],
    success: [146, 214, 177],
  },
  ember: {
    accent: [241, 173, 121],
    background: "#191210",
    neutral: [158, 148, 144],
    warning: [245, 200, 119],
    error: [244, 133, 144],
    success: [164, 208, 151],
  },
  paper: {
    accent: [61, 96, 55],
    background: "#e9eae3",
    neutral: [101, 103, 104],
    warning: [143, 85, 17],
    error: [168, 52, 71],
    success: [49, 112, 58],
  },
});
export function normalizeAtmosphere(value) {
  return Object.hasOwn(ATMOSPHERES, value) ? value : "phosphor";
}
// Color belongs to presentation. Neither a theme nor a user gesture changes backend truth.
export function atmosphereColor(theme, state) {
  const palette = ATMOSPHERES[normalizeAtmosphere(theme)];
  if (["offline", "connecting", "cancelled", "unknown", "not-configured"].includes(state))
    return palette.neutral;
  if (["waiting_approval", "fallback"].includes(state)) return palette.warning;
  if (state === "error") return palette.error;
  if (state === "success") return palette.success;
  return palette.accent;
}
export function initializeAtmosphere(orb) {
  const buttons = [...document.querySelectorAll("[data-atmosphere]")].filter(
    (el) => el.tagName === "BUTTON",
  );
  function select(value) {
    const theme = normalizeAtmosphere(value);
    document.documentElement.dataset.atmosphere = theme;
    document.querySelector('meta[name="theme-color"]').content = ATMOSPHERES[theme].background;
    for (const button of buttons)
      button.setAttribute("aria-pressed", String(button.dataset.atmosphere === theme));
    orb.atmosphere = theme;
    try {
      localStorage.setItem("jarvis-atmosphere", theme);
    } catch {
      /* Optional preference storage. */
    }
  }
  select(document.documentElement.dataset.atmosphere);
  for (const button of buttons)
    button.addEventListener("click", () => select(button.dataset.atmosphere));
  window.addEventListener("storage", (event) => {
    if (event.key === "jarvis-atmosphere") select(event.newValue);
  });
}
