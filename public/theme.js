(() => {
  const key = "chatcode-theme";
  const themes = ["obsidian", "nebula", "crimson", "silver"];
  const colors = {obsidian: "#0c0d0f", nebula: "#090b12", crimson: "#0d0e10", silver: "#f4f5f7"};
  const meta = document.querySelector('meta[name="theme-color"]');

  function saved() {
    try {
      const value = localStorage.getItem(key);
      if (themes.includes(value)) return value;
    } catch {}
    return "obsidian";
  }

  function apply(value, persist) {
    const theme = themes.includes(value) ? value : "obsidian";
    document.documentElement.dataset.theme = theme;
    if (meta) meta.setAttribute("content", colors[theme]);
    for (const select of document.querySelectorAll("select[data-theme-select]")) select.value = theme;
    if (persist) try { localStorage.setItem(key, theme); } catch {}
  }

  apply(saved());

  function wire() {
    for (const select of document.querySelectorAll("select[data-theme-select]"))
      select.addEventListener("change", () => apply(select.value, true));
    apply(document.documentElement.dataset.theme);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
