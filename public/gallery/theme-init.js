(function () {
  const stored = localStorage.getItem("gallery_theme"),
    p = ["system", "dark", "light"].includes(stored) ? stored : "system",
    theme =
      p === "system"
        ? matchMedia("(prefers-color-scheme:light)").matches
          ? "light"
          : "dark"
        : p;
  document.documentElement.dataset.theme = theme;
})();
