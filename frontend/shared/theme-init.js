(function () {
  "use strict";
  // 在样式表之前同步执行：把偏好（system / dark / light）解析成具体主题写入 data-theme，
  // 这样 CSS 只需维护一份 [data-theme="light"]，不必再复制一份 prefers-color-scheme 副本。
  try {
    var preference = localStorage.getItem("gallery_theme");
    var resolved =
      preference === "dark" || preference === "light"
        ? preference
        : matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
    document.documentElement.setAttribute("data-theme", resolved);
  } catch (error) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
