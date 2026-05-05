var GalleryTheme = (function () {
  "use strict";

  var STORAGE_KEY = "gallery_theme";
  var ALLOWED = ["system", "dark", "light"];
  var systemQuery = matchMedia("(prefers-color-scheme: light)");

  function current() {
    var value = localStorage.getItem(STORAGE_KEY) || "system";
    return ALLOWED.indexOf(value) >= 0 ? value : "system";
  }

  // 偏好存的是 system / dark / light，但 data-theme 上始终是解析后的具体主题。
  function resolve(preference) {
    if (preference === "dark" || preference === "light") return preference;
    return systemQuery.matches ? "light" : "dark";
  }

  function stamp(resolved) {
    var root = document.documentElement;
    if (root.getAttribute("data-theme") === resolved) return;
    root.classList.add("theme-switching");
    root.setAttribute("data-theme", resolved);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        root.classList.remove("theme-switching");
      });
    });
  }

  function apply(value) {
    value = ALLOWED.indexOf(value) >= 0 ? value : "system";
    localStorage.setItem(STORAGE_KEY, value);
    stamp(resolve(value));
    document.dispatchEvent(
      new CustomEvent("gallery-theme-change", { detail: { theme: value } }),
    );
    return value;
  }

  systemQuery.addEventListener("change", function () {
    if (current() === "system") stamp(resolve("system"));
  });

  apply(current());
  return { current: current, apply: apply };
})();

export { GalleryTheme };
