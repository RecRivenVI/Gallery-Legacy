export function init() {
  (function applyStoredDisplayPreferences() {
    // 宽度按断点读取：移动端禁用「全屏」，强制默认宽度；桌面端读取桌面配置。
    var mobile = !!(
      window.matchMedia && window.matchMedia("(max-width: 768px)").matches
    );
    var widthMode = mobile
      ? "standard"
      : localStorage.getItem("gallery_content_width");
    document.documentElement.setAttribute(
      "data-gallery-width",
      widthMode === "wide" ? "wide" : "standard",
    );
    document.body.classList.toggle(
      "privacy-blur",
      localStorage.getItem("gallery_privacy_blur") === "1",
    );
  })();
}
