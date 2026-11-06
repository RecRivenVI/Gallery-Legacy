// Browser startup only. Product state, layout and interaction live in Kotlin.
const mode = localStorage.getItem("gallery_theme") || "system";
const dark =
  mode === "dark" ||
  (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
document.documentElement.style.setProperty(
  "--initial-background",
  dark ? "#111213" : "#f2f2f0",
);
document.documentElement.style.colorScheme = dark ? "dark" : "light";
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => import("./ui.js"), {
    once: true,
  });
} else {
  import("./ui.js");
}
