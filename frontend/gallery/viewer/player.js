import { apiUrl } from "../view-data.js";
import {
  RouteAnchor,
  buildDbLightboxHash,
  buildDbRouteHash,
  copyMediaLink,
  cssEscape,
  downloadUrl,
  state,
} from "../model.js";
import { switchDbFolderLightbox, syncFsLightboxPage } from "../controller.js";
var LB = (function () {
  var FADE_MS = 200;

  var images = [],
    types = [],
    names = [];
  var idx = 0,
    open = false;
  var lastVisibleMediaName = "";
  var lastVisibleFolderPath = "";
  var dbContext = null;
  var closeScrollFrame = 0;
  var fsPageSyncToken = 0;
  var fsHistoryRebaseInProgress = false;
  var lightboxHistoryActive = false;
  var animating = false;
  var lightboxChromeVisible = false;
  var lightboxChromeToken = 0;
  var lightboxOverlayToken = 0;
  var lightboxOverlayVisible = false;
  var lightboxSessionToken = 0;
  var zoom = 1,
    panX = 0,
    panY = 0;
  var isPanning = false,
    panSX = 0,
    panSY = 0,
    panSPX = 0,
    panSPY = 0;
  var isSwiping = false,
    swSX = 0,
    swSY = 0,
    swST = 0;
  var pinchDist = 0,
    pinchZoom = 1;
  var lastTapT = 0,
    tapX = 0,
    tapY = 0;
  var isMDrag = false,
    mSX = 0,
    mSY = 0,
    mSPX = 0,
    mSPY = 0;
  var _ptrDownBtn = false;

  var slots = [null, null, null];
  var slotIdx = [-1, -1, -1];

  var overlay,
    slider,
    closeBtn,
    prevBtn,
    nextBtn,
    loadBtn,
    copyBtn,
    hideBtn,
    bottom,
    counter,
    zoomSlider,
    zoomLabel,
    loadingEl,
    _loading = false;

  function getSlot(s) {
    return slots[s];
  }
  function getSlotMedia(s) {
    var el = slots[s];
    return el ? el.querySelector("img") || el.querySelector("video") : null;
  }

  function clearSlot(s) {
    var el = slots[s];
    if (el) {
      el.classList.remove("active", "is-interacting");
      var v = el.querySelector("video");
      if (v) {
        v.pause();
        v.src = "";
      }
      var i = el.querySelector("img");
      if (i) i.src = "";
      el.innerHTML = "";
    }
    slotIdx[s] = -1;
  }

  function addSubtitles(video, fileName) {
    var dotIdx = fileName.lastIndexOf(".");
    if (dotIdx === -1) return;
    var baseName = fileName.substring(0, dotIdx);
    var prefix = getMediaBasePath();

    function addTrack(name, lang, label, isDefault) {
      var t = document.createElement("track");
      t.kind = "subtitles";
      t.srclang = lang;
      t.label = label;
      t.src = apiUrl("media", prefix + "/" + name);
      if (isDefault) t.default = true;
      video.appendChild(t);
    }

    addTrack(baseName + ".en-US.vtt", "en-US", "English", false);
    addTrack(baseName + ".zh-CN.vtt", "zh-CN", "中文", true);
  }

  function updateMediaSession(mediaIdx) {
    if (!("mediaSession" in navigator)) return;
    var name = names[mediaIdx] || "";
    var prefix = getMediaBasePath();
    var fullPath = prefix ? prefix + "/" + name : "/" + name;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: name,
      artwork: [
        {
          src: apiUrl("thumbnail", fullPath),
          sizes: "512x512",
          type: "image/webp",
        },
      ],
    });
  }

  function assignSlot(s, imgIdx) {
    var el = slots[s];
    el.innerHTML = "";
    var isVid = types[imgIdx] === "vid";
    var media = document.createElement(isVid ? "video" : "img");
    media.draggable = false;
    if (isVid) {
      media.controls = true;
      media.playsInline = true;
      media.preload = "auto";
      media.loop = true;
      media.volume = 0.5;
      addSubtitles(media, names[imgIdx]);
    }
    media.src = images[imgIdx];
    el.appendChild(media);
    slotIdx[s] = imgIdx;
  }

  function initSlides() {
    slider.innerHTML = "";
    for (var s = 0; s < 3; s++) {
      var slide = document.createElement("div");
      slide.className = "lb-slide";
      var img = document.createElement("img");
      img.draggable = false;
      slide.appendChild(img);
      slider.appendChild(slide);
      slots[s] = slide;
      slotIdx[s] = -1;
    }
  }

  function activeSlotIndex() {
    for (var s = 0; s < 3; s++) if (slotIdx[s] === idx) return s;
    return -1;
  }

  function getActiveMedia() {
    var s = activeSlotIndex();
    return s >= 0 ? getSlotMedia(s) : null;
  }

  function render() {
    var m = getActiveMedia();
    if (!m) return;
    if (zoom <= 1) {
      panX = 0;
      panY = 0;
    }
    m.style.setProperty("--z", zoom);
    m.style.setProperty("--px", panX + "px");
    m.style.setProperty("--py", panY + "px");
    zoomSlider.value = Math.round(zoom * 100);
    zoomLabel.textContent = Math.round(zoom * 100) + "%";
  }

  function setInteracting(on) {
    var s = activeSlotIndex();
    if (s >= 0) slots[s].classList.toggle("is-interacting", on);
  }

  function hasDbFolderStep(direction) {
    if (!dbContext || dbContext.source !== "db-folder") return false;
    var folderList = dbContext.folderList || [];
    var folderIndex =
      dbContext.folderIndex == null ? -1 : dbContext.folderIndex;
    var page = dbContext.page || state.page || 1;
    var totalPages = dbContext.totalPages || state.totalPages || 1;
    if (direction < 0) return folderIndex > 0 || page > 1;
    return (
      (folderIndex >= 0 && folderIndex < folderList.length - 1) ||
      page < totalPages
    );
  }

  function createSvgEl(name) {
    return document.createElementNS("http://www.w3.org/2000/svg", name);
  }

  var NAV_ARROW_POINTS = {
    prev: "15,18 9,12 15,6",
    next: "9,18 15,12 9,6",
  };

  function navDirectionName(direction) {
    return direction < 0 ? "prev" : "next";
  }

  function navArrowPoints(direction) {
    return NAV_ARROW_POINTS[navDirectionName(direction)];
  }

  function setNavArrowGeometry(arrow, direction) {
    if (arrow) arrow.setAttribute("points", navArrowPoints(direction));
  }

  function createNavArrow(direction) {
    var arrow = createSvgEl("polyline");
    setNavArrowGeometry(arrow, direction);
    return arrow;
  }

  function applyNavSvgAttributes(svg) {
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
  }

  function createFolderNavIcon(direction) {
    var svg = createSvgEl("svg");
    svg.setAttribute(
      "class",
      "lb-nav-icon lb-nav-icon-cross-folder lb-nav-icon-" +
        navDirectionName(direction) +
        "-folder",
    );
    applyNavSvgAttributes(svg);

    var tipX = direction < 0 ? 9 : 15;
    var bar = createSvgEl("line");
    bar.setAttribute("class", "lb-folder-bar");
    bar.setAttribute("x1", String(tipX));
    bar.setAttribute("x2", String(tipX));
    bar.setAttribute("y1", "6");
    bar.setAttribute("y2", "18");
    svg.appendChild(bar);

    var chevron = createNavArrow(direction);
    chevron.setAttribute("class", "lb-folder-chevron");
    svg.appendChild(chevron);

    return svg;
  }

  function setupNavButtonIcon(btn, direction) {
    if (!btn) return;
    var normal = btn.querySelector("svg");
    if (normal) {
      normal.classList.add("lb-nav-icon", "lb-nav-icon-normal");
      normal.setAttribute("aria-hidden", "true");
      setNavArrowGeometry(normal.querySelector("polyline"), direction);
    }
    if (!btn.querySelector(".lb-nav-icon-cross-folder")) {
      btn.appendChild(createFolderNavIcon(direction));
    }
    btn.setAttribute("data-lb-nav-mode", "media");
    btn.setAttribute("data-lb-nav-target-mode", "media");
  }

  function applyFolderJumpMode(btn, mode) {
    btn.setAttribute("data-lb-nav-mode", mode);
    btn.classList.toggle("lb-folder-jump", mode === "folder");
  }

  function setFolderJumpButton(btn, enabled, label) {
    var nextMode = enabled ? "folder" : "media";
    var currentMode = btn.getAttribute("data-lb-nav-mode") || "media";
    var targetMode = btn.getAttribute("data-lb-nav-target-mode") || currentMode;
    btn.setAttribute("data-lb-nav-target-mode", nextMode);
    if (enabled) {
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", label);
    } else {
      btn.removeAttribute("aria-label");
      btn.removeAttribute("title");
    }
    if (currentMode === nextMode) {
      if (btn._lbIconTimer) {
        clearTimeout(btn._lbIconTimer);
        btn._lbIconTimer = 0;
      }
      btn.classList.remove("lb-icon-changing");
      applyFolderJumpMode(btn, nextMode);
      return;
    }
    if (targetMode === nextMode && btn._lbIconTimer) return;
    if (btn._lbIconTimer) clearTimeout(btn._lbIconTimer);
    btn.classList.add("lb-icon-changing");
    btn._lbIconTimer = setTimeout(
      function () {
        btn._lbIconTimer = 0;
        applyFolderJumpMode(btn, nextMode);
        requestAnimationFrame(function () {
          if (
            (btn.getAttribute("data-lb-nav-target-mode") || "media") ===
            nextMode
          ) {
            btn.classList.remove("lb-icon-changing");
          }
        });
      },
      Math.max(80, Math.floor(FADE_MS / 2)),
    );
  }

  function getNavMode(direction) {
    if (direction < 0) {
      if (idx > 0) return "media";
      if (hasDbFolderStep(-1) && typeof switchDbFolderLightbox === "function")
        return "folder";
      return "none";
    }
    if (idx < images.length - 1) return "media";
    if (hasDbFolderStep(1) && typeof switchDbFolderLightbox === "function")
      return "folder";
    return "none";
  }

  function navigateLightboxDirection(direction) {
    if (animating) return false;
    var mode = getNavMode(direction);
    if (mode === "media") {
      changeSlide(idx + (direction < 0 ? -1 : 1));
      return true;
    }
    if (mode === "folder") {
      switchDbFolderLightbox(direction < 0 ? -1 : 1);
      return true;
    }
    return false;
  }

  function updateNav() {
    if (!prevBtn || !nextBtn) return;
    var visible = lightboxChromeVisible && open;
    var prevMode = getNavMode(-1);
    var nextMode = getNavMode(1);
    var prevFolder = prevMode === "folder";
    var nextFolder = nextMode === "folder";
    prevBtn.classList.toggle("visible", visible && prevMode !== "none");
    nextBtn.classList.toggle("visible", visible && nextMode !== "none");
    setFolderJumpButton(prevBtn, prevFolder, "上一个作品");
    setFolderJumpButton(nextBtn, nextFolder, "下一个作品");
  }

  function updateCounter() {
    counter.textContent = idx + 1 + " / " + images.length;
  }

  function resetZoom() {
    zoom = 1;
    panX = 0;
    panY = 0;
    render();
  }

  function beginMediaSwitch(direction) {
    if (!open || !overlay) return false;
    cancelZoomInteraction();
    overlay.classList.add("lb-media-switching");
    overlay.setAttribute(
      "data-lb-media-switch",
      direction < 0 ? "prev-folder" : "next-folder",
    );
    if (loadingEl) loadingEl.classList.add("show");
    [prevBtn, nextBtn].forEach(function (btn) {
      if (!btn) return;
      btn.classList.add("lb-db-switch-locked");
      btn.setAttribute("aria-disabled", "true");
    });
    var activeBtn = direction < 0 ? prevBtn : nextBtn;
    if (activeBtn) {
      activeBtn.classList.add("lb-folder-loading");
      activeBtn.setAttribute("aria-busy", "true");
    }
    return true;
  }

  function finishMediaSwitch(fadeIn) {
    if (!overlay) return;
    if (loadingEl) loadingEl.classList.remove("show");
    [prevBtn, nextBtn].forEach(function (btn) {
      if (!btn) return;
      btn.classList.remove("lb-db-switch-locked", "lb-folder-loading");
      btn.removeAttribute("aria-disabled");
      btn.removeAttribute("aria-busy");
    });
    function reveal() {
      overlay.classList.remove("lb-media-switching");
      overlay.removeAttribute("data-lb-media-switch");
    }
    if (fadeIn) {
      requestAnimationFrame(function () {
        requestAnimationFrame(reveal);
      });
    } else {
      reveal();
    }
  }

  function getMediaNameAt(mediaIndex) {
    if (mediaIndex == null || mediaIndex < 0) return "";
    if (names && names[mediaIndex]) return names[mediaIndex];
    var media = state.allMedia && state.allMedia[mediaIndex];
    return media ? media.name : "";
  }

  function getMediaKey(mediaIndex, mediaName) {
    return (
      mediaName ||
      getMediaNameAt(mediaIndex) ||
      (mediaIndex != null ? "idx:" + mediaIndex : "")
    );
  }

  function canAdjustZoom() {
    return open && lightboxChromeVisible && !animating;
  }

  function cancelZoomInteraction() {
    isPanning = false;
    isMDrag = false;
    pinchDist = 0;
    setInteracting(false);
  }

  function guardZoomInteraction() {
    if (canAdjustZoom()) return true;
    cancelZoomInteraction();
    if (zoomSlider) zoomSlider.value = Math.round(zoom * 100);
    if (zoomLabel) zoomLabel.textContent = Math.round(zoom * 100) + "%";
    return false;
  }

  function rememberCurrentMedia() {
    lastVisibleMediaName = names[idx] || "";
    lastVisibleFolderPath =
      dbContext && dbContext.folderPath ? dbContext.folderPath : "";
    if (dbContext) {
      dbContext.mediaIndex = idx;
      if (state.dbLightbox) state.dbLightbox.mediaIndex = idx;
    }
  }

  // 文件系统灯箱 = 不在 DB 上下文里的浏览灯箱。文件根（miscMode / view="misc"）也算：
  // 它和普通目录浏览的差别只是问哪个端点，灯箱行为应当完全一致。以前这里把 misc 整个排除，
  // 结果文件根下翻到当前页之外的媒体时，底层页面根本不会跟着翻页。
  function isFsBrowseLightbox() {
    return (
      !dbContext &&
      (state.view === "browse" || state.view === "misc") &&
      !state.searchQuery &&
      !state.dbLightbox
    );
  }

  function hasCurrentMediaCard(mediaIndex) {
    return !!document.querySelector(
      '.card.img[data-lb-index="' + mediaIndex + '"]',
    );
  }

  function syncFsPageForCurrentMedia() {
    if (!isFsBrowseLightbox() || hasCurrentMediaCard(idx)) return false;
    if (typeof syncFsLightboxPage !== "function") return false;
    var mediaName = names[idx] || "";
    if (!mediaName) return false;
    var expectedIndex = idx;
    var token = ++fsPageSyncToken;
    syncFsLightboxPage(mediaName).then(function (data) {
      if (token !== fsPageSyncToken || !open || dbContext) return;
      if (idx !== expectedIndex || names[idx] !== mediaName) return;
      if (data) {
        rememberCurrentMedia();
        rebaseFsLightboxHistory();
        updateNav();
      }
    });
    return true;
  }

  function clearReturnAnchor() {
    lastVisibleMediaName = "";
    lastVisibleFolderPath = "";
    if (closeScrollFrame) {
      cancelAnimationFrame(closeScrollFrame);
      closeScrollFrame = 0;
    }
  }

  function findRememberedMediaIndex() {
    if (!lastVisibleMediaName) return;
    var mediaList =
      dbContext && dbContext.mediaList ? dbContext.mediaList : state.allMedia;
    for (var i = 0; i < mediaList.length; i++) {
      if (mediaList[i].name === lastVisibleMediaName) {
        return i;
      }
    }
  }

  function findRememberedMediaCard() {
    if (lastVisibleFolderPath) {
      var dirSelector =
        '.card.dir[data-path="' + cssEscape(lastVisibleFolderPath) + '"]';
      var dirCard = document.querySelector(dirSelector);
      if (dirCard) return dirCard;
      var dirCards = document.querySelectorAll(".card.dir[data-path]");
      for (var d = 0; d < dirCards.length; d++) {
        if (dirCards[d].getAttribute("data-path") === lastVisibleFolderPath)
          return dirCards[d];
      }
      return null;
    }
    var targetIdx = findRememberedMediaIndex();
    if (targetIdx == null || targetIdx < 0) return;

    var cardEl = document.querySelector(
      '.card.img[data-lb-index="' + targetIdx + '"]',
    );
    if (!cardEl) return;
    return cardEl;
  }

  function highlightReturnCard(cardEl) {
    if (!cardEl) return;
    cardEl.classList.add("lb-return-highlight");
    setTimeout(function () {
      cardEl.classList.remove("lb-return-highlight");
    }, 3000);
  }

  function closeEase(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function maxScrollY() {
    var doc = document.documentElement;
    var body = document.body;
    return Math.max(
      0,
      Math.max(doc.scrollHeight, body.scrollHeight) - window.innerHeight,
    );
  }

  function prepareReturnTarget() {
    var cardEl = findRememberedMediaCard();
    if (!cardEl) return null;
    var rect = cardEl.getBoundingClientRect();
    var visualEl =
      cardEl.querySelector(".thumb-clip") ||
      cardEl.querySelector(".thumb img") ||
      cardEl.querySelector(".thumb") ||
      cardEl;
    var visualRect = visualEl.getBoundingClientRect();
    var targetScrollY =
      window.scrollY + rect.top + rect.height / 2 - window.innerHeight / 2;
    targetScrollY = Math.max(0, Math.min(maxScrollY(), targetScrollY));
    return {
      cardEl: cardEl,
      scrollY: targetScrollY,
      rect: {
        top: visualRect.top + window.scrollY - targetScrollY,
        left: visualRect.left,
        width: visualRect.width,
        height: visualRect.height,
      },
    };
  }

  function animateScrollTo(targetY, duration) {
    if (closeScrollFrame) cancelAnimationFrame(closeScrollFrame);
    var startY = window.scrollY;
    var deltaY = targetY - startY;
    if (duration <= 0 || Math.abs(deltaY) < 1) {
      window.scrollTo(window.scrollX, targetY);
      closeScrollFrame = 0;
      return;
    }
    var startTime = 0;
    function step(ts) {
      if (!startTime) startTime = ts;
      var t = Math.min(1, (ts - startTime) / duration);
      window.scrollTo(window.scrollX, startY + deltaY * closeEase(t));
      if (t < 1) {
        closeScrollFrame = requestAnimationFrame(step);
      } else {
        closeScrollFrame = 0;
        window.scrollTo(window.scrollX, targetY);
      }
    }
    closeScrollFrame = requestAnimationFrame(step);
  }

  function startReturnScroll(returnTarget, duration) {
    if (!returnTarget) return;
    document.body.style.overflow = "";
    animateScrollTo(returnTarget.scrollY, duration);
  }

  function restoreLastMediaScroll() {
    var returnTarget = prepareReturnTarget();
    if (!returnTarget) return;
    startReturnScroll(returnTarget, 0);
    highlightReturnCard(returnTarget.cardEl);
  }

  function setLightboxOverlayVisible(visible, immediate) {
    if (!overlay) return;
    lightboxOverlayVisible = !!visible;
    var token = ++lightboxOverlayToken;
    if (visible) {
      if (immediate) overlay.style.transition = "none";
      void overlay.offsetWidth;
      overlay.classList.add("active");
      if (immediate) {
        void overlay.offsetWidth;
        overlay.style.transition = "";
      }
      return token;
    }

    if (immediate) overlay.style.transition = "none";
    overlay.classList.remove("active");
    if (immediate) {
      void overlay.offsetWidth;
      overlay.style.transition = "";
    }
    return token;
  }

  function showLightboxChrome() {
    if (!open) return;
    var token = ++lightboxChromeToken;
    lightboxChromeVisible = true;
    bottom.style.display = "flex";
    void bottom.offsetWidth;
    bottom.classList.add("show");
    updateCounter();
    updateNav();
    closeBtn.classList.add("visible");
    loadBtn.classList.add("visible");
    copyBtn.classList.add("visible");
    hideBtn.classList.add("visible");
    if (localStorage.getItem("gallery_lb_hidden"))
      overlay.classList.add("lb-hide-active");
    setTimeout(function () {
      if (token !== lightboxChromeToken || !open || !lightboxChromeVisible)
        return;
      closeBtn.classList.add("visible");
      updateNav();
    }, 50);
  }

  function clearLightboxChrome() {
    lightboxChromeToken++;
    lightboxChromeVisible = false;
    bottom.classList.remove("show");
    closeBtn.classList.remove("visible", "is-pressing");
    prevBtn.classList.remove("visible", "is-pressing");
    nextBtn.classList.remove("visible", "is-pressing");
    loadBtn.classList.remove("visible", "is-pressing", "success");
    copyBtn.classList.remove("visible", "is-pressing", "copied");
    hideBtn.classList.remove("visible", "is-pressing");
    var token = lightboxChromeToken;
    setTimeout(function () {
      if (token !== lightboxChromeToken || lightboxChromeVisible) return;
      bottom.style.display = "none";
    }, FADE_MS + 50);
  }

  function buildReturnPageHash(path, page) {
    return "#" + path + (page > 1 ? "?page=" + page : "");
  }

  function getMediaBasePath() {
    return dbContext && dbContext.folderPath
      ? dbContext.folderPath
      : state.path === "/"
        ? ""
        : state.path;
  }

  function buildMediaHash() {
    if (dbContext && dbContext.source === "db-folder") {
      return buildDbLightboxHash(dbContext, names[idx] || "");
    }
    var media = state.allMedia[idx];
    var hash = "#" + state.path + "?page=" + state.page;
    if (media) hash += "&media=" + encodeURIComponent(media.name);
    return hash;
  }

  function pushLightboxHistory() {
    history.pushState({ lightbox: true }, "", buildMediaHash());
    lightboxHistoryActive = true;
  }

  function replaceLightboxHistory() {
    history.replaceState({ lightbox: true }, "", buildMediaHash());
  }

  function rebaseFsLightboxHistory() {
    var cleanHash = buildReturnPageHash(state.path, state.page);
    var mediaHash = buildMediaHash();
    if (!lightboxHistoryActive) {
      history.replaceState({ lightbox: true }, "", mediaHash);
      lightboxHistoryActive = true;
      return;
    }
    if (fsHistoryRebaseInProgress) {
      replaceLightboxHistory();
      return;
    }

    fsHistoryRebaseInProgress = true;
    var finished = false;
    var fallbackTimer = 0;

    function finishRebase() {
      if (finished) return;
      finished = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fsHistoryRebaseInProgress = false;
      window.removeEventListener("popstate", finishRebase);
      history.replaceState(null, "", cleanHash);
      history.pushState({ lightbox: true }, "", mediaHash);
      lightboxHistoryActive = true;
    }

    window.addEventListener("popstate", finishRebase);
    history.back();
    fallbackTimer = setTimeout(finishRebase, 500);
  }

  function cleanMediaHashAfterClose() {
    var cleanHash =
      dbContext && dbContext.source === "db-folder"
        ? buildDbRouteHash(dbContext)
        : buildReturnPageHash(state.path, state.page);
    if (window.location.hash !== cleanHash) {
      history.replaceState(null, "", cleanHash);
    }
  }

  function changeSlide(newIdx) {
    if (newIdx === idx || newIdx < 0 || newIdx >= images.length || animating)
      return;
    var oldSlot = activeSlotIndex();
    idx = newIdx;
    rememberCurrentMedia();
    syncFsPageForCurrentMedia();
    replaceLightboxHistory();
    updateCounter();
    updateNav();

    var newSlot = -1;
    for (var s = 0; s < 3; s++)
      if (slotIdx[s] === idx) {
        newSlot = s;
        break;
      }

    if (newSlot < 0) {
      var victim = 0,
        maxDist = -1;
      for (var s2 = 0; s2 < 3; s2++) {
        var d = slotIdx[s2] < 0 ? Infinity : Math.abs(slotIdx[s2] - idx);
        if (d > maxDist) {
          maxDist = d;
          victim = s2;
        }
      }
      if (oldSlot >= 0 && slots[oldSlot])
        slots[oldSlot].classList.remove("active");
      clearSlot(victim);
      assignSlot(victim, idx);
      newSlot = victim;
    }

    if (oldSlot >= 0 && oldSlot !== newSlot) {
      var om = getSlotMedia(oldSlot);
      if (om && om.tagName === "VIDEO") om.pause();
      slots[oldSlot].classList.remove("active");
    }

    slots[newSlot].classList.add("active");
    var ni = getSlotMedia(newSlot);
    if (ni) {
      void ni.offsetWidth;
      ni.style.opacity = "1";
      if (ni.tagName === "VIDEO") {
        updateMediaSession(idx);
        ni.play()["catch"](function () {});
      }
    }

    var preloads = [idx - 1, idx + 1];
    var usedSlots = new Set([newSlot]);
    for (var pi = 0; pi < preloads.length; pi++) {
      var pIdx = preloads[pi];
      if (pIdx < 0 || pIdx >= images.length) continue;
      var already = false;
      for (var s3 = 0; s3 < 3; s3++) {
        if (slotIdx[s3] === pIdx) {
          already = true;
          break;
        }
      }
      if (already) continue;
      for (var s4 = 0; s4 < 3; s4++) {
        if (!usedSlots.has(s4) && slotIdx[s4] < 0) {
          assignSlot(s4, pIdx);
          usedSlots.add(s4);
          break;
        }
      }
    }
    resetZoom();
  }

  function setupSlidesForCurrentIndex() {
    initSlides();
    assignSlot(0, idx);
    if (idx > 0) assignSlot(1, idx - 1);
    else if (idx + 1 < images.length) assignSlot(1, idx + 1);
    if (idx + 1 < images.length) assignSlot(2, idx + 1);
    else if (idx > 0) assignSlot(2, idx - 1);
    resetZoom();
  }

  function openAt(startIdx, opts) {
    opts = opts || {};
    if (images.length === 0 || animating) return;
    if (open) {
      var animateSwitch =
        !!opts.animateSwitch &&
        overlay &&
        overlay.classList.contains("lb-media-switching");
      idx = Math.max(0, Math.min(startIdx, images.length - 1));
      rememberCurrentMedia();
      setupSlidesForCurrentIndex();
      if (opts.pushHistory) pushLightboxHistory();
      else replaceLightboxHistory();
      updateCounter();
      updateNav();
      slots[0].classList.add("active");
      var activeMedia = getSlotMedia(0);
      if (activeMedia) {
        void activeMedia.offsetWidth;
        activeMedia.style.opacity = "1";
        if (activeMedia.tagName === "VIDEO") {
          updateMediaSession(idx);
          activeMedia.play()["catch"](function () {});
        }
      }
      if (animateSwitch) {
        finishMediaSwitch(true);
      }
      return;
    }
    animating = true;
    lightboxSessionToken++;
    idx = Math.max(0, Math.min(startIdx, images.length - 1));
    rememberCurrentMedia();

    setupSlidesForCurrentIndex();

    setLightboxOverlayVisible(true);
    if (opts.replaceHistory) {
      history.replaceState({ lightbox: true }, "", buildMediaHash());
      lightboxHistoryActive = true;
    } else {
      pushLightboxHistory();
    }
    open = true;
    document.body.style.overflow = "hidden";

    showLightboxChrome();
    updateCounter();
    updateNav();
    if (localStorage.getItem("gallery_lb_hidden"))
      overlay.classList.add("lb-hide-active");

    slots[0].classList.add("active");
    var m0 = getSlotMedia(0);
    if (m0) {
      void m0.offsetWidth;
      m0.style.opacity = "1";
      if (m0.tagName === "VIDEO") {
        updateMediaSession(idx);
        m0.play()["catch"](function () {});
      }
    }

    setTimeout(function () {
      animating = false;
    }, FADE_MS);
  }

  function close(opts) {
    if (!open) return;
    opts = opts || {};
    var skipAnim = !!opts.skipAnim;
    var restoreScroll = opts.restoreScroll !== false;
    var shouldRestoreDbRouteAnchor =
      dbContext && dbContext.source === "db-folder";

    if (animating && !skipAnim) return;
    animating = true;

    cancelZoomInteraction();
    setLightboxOverlayVisible(false, skipAnim);
    clearLightboxChrome();

    var returnTarget = restoreScroll ? prepareReturnTarget() : null;
    if (returnTarget) {
      document.body.style.overflow = "";
      startReturnScroll(returnTarget, skipAnim ? 0 : FADE_MS);
    }

    function finish() {
      animating = false;
      open = false;
      lightboxHistoryActive = false;
      document.body.style.overflow = "";
      overlay.classList.remove("lb-hide-active");
      for (var s = 0; s < 3; s++) clearSlot(s);
      if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;

      if (opts.updateHistory === true || opts.cleanMediaHash) {
        cleanMediaHashAfterClose();
      }

      if (returnTarget) {
        highlightReturnCard(returnTarget.cardEl);
      } else if (restoreScroll) {
        requestAnimationFrame(restoreLastMediaScroll);
      }

      if (
        shouldRestoreDbRouteAnchor &&
        typeof RouteAnchor !== "undefined" &&
        RouteAnchor.restoreAfterRender
      ) {
        RouteAnchor.restoreAfterRender();
      }

      if (opts.clearReturnAnchor) clearReturnAnchor();
      dbContext = null;
      state.dbLightbox = null;
    }

    if (skipAnim) {
      finish();
    } else {
      setTimeout(finish, FADE_MS);
    }
  }

  function requestCloseFromUser() {
    if (!open || animating) return;
    if (lightboxHistoryActive) {
      history.back();
      return;
    }
    close({
      restoreScroll: true,
      clearReturnAnchor: false,
      cleanMediaHash: true,
    });
  }

  function bindPressableButton(btn, action) {
    var pointerId = null;
    var releaseTimer = 0;
    var clickSuppressTimer = 0;
    var suppressNextClick = false;

    function clearReleaseTimer() {
      if (releaseTimer) {
        clearTimeout(releaseTimer);
        releaseTimer = 0;
      }
    }

    function clearSuppressTimer() {
      if (clickSuppressTimer) {
        clearTimeout(clickSuppressTimer);
        clickSuppressTimer = 0;
      }
    }

    function releasePress(delay) {
      clearReleaseTimer();
      releaseTimer = setTimeout(function () {
        btn.classList.remove("is-pressing");
        releaseTimer = 0;
      }, delay || 0);
    }

    btn.addEventListener("pointerdown", function (e) {
      if (e.button != null && e.button !== 0) return;
      pointerId = e.pointerId;
      clearReleaseTimer();
      btn.classList.add("is-pressing");
      if (e.pointerType && e.pointerType !== "mouse") {
        suppressNextClick = true;
        clearSuppressTimer();
        try {
          btn.setPointerCapture(e.pointerId);
        } catch (err) {}
        e.preventDefault();
      }
    });

    btn.addEventListener("pointerup", function (e) {
      if (pointerId != null && e.pointerId !== pointerId) return;
      var isTouchLike = e.pointerType && e.pointerType !== "mouse";
      pointerId = null;
      if (!isTouchLike) {
        btn.classList.remove("is-pressing");
        return;
      }

      e.preventDefault();
      clickSuppressTimer = setTimeout(function () {
        suppressNextClick = false;
        clickSuppressTimer = 0;
      }, 700);
      setTimeout(function () {
        action();
        releasePress(180);
      }, 48);
    });

    btn.addEventListener("pointercancel", function () {
      pointerId = null;
      releasePress(0);
    });

    btn.addEventListener("pointerleave", function (e) {
      if (e.pointerType === "mouse") btn.classList.remove("is-pressing");
    });

    btn.addEventListener("click", function (e) {
      if (suppressNextClick) {
        e.preventDefault();
        e.stopPropagation();
        suppressNextClick = false;
        clearSuppressTimer();
        return;
      }
      action();
    });
  }

  function isOpen() {
    return open;
  }

  function setMedia(urls, typs, nms, context) {
    images = urls;
    types = typs;
    names = nms || [];
    dbContext = context || null;
  }

  function init() {
    overlay = document.querySelector(".lb-overlay");
    slider = overlay.querySelector(".lb-slider");
    closeBtn = document.querySelector(".lb-close");
    prevBtn = document.querySelector(".lb-prev");
    nextBtn = document.querySelector(".lb-next");
    setupNavButtonIcon(prevBtn, -1);
    setupNavButtonIcon(nextBtn, 1);
    loadBtn = document.querySelector(".lb-download");
    copyBtn = document.querySelector(".lb-copy");
    hideBtn = document.querySelector(".lb-hide");
    bottom = document.querySelector(".lb-bottom");
    counter = bottom.querySelector(".lb-counter");
    zoomSlider = bottom.querySelector(".lb-zoom-slider");
    zoomLabel = bottom.querySelector(".lb-zoom-label");

    loadingEl = document.createElement("div");
    loadingEl.className = "lb-loading";
    loadingEl.innerHTML = '<div class="lb-spinner"></div>';
    overlay.appendChild(loadingEl);

    document.addEventListener("click", function (e) {
      if (e.target.closest(".dl-btn") || e.target.closest(".link-btn")) return;
      var card = e.target.closest(".card.img");
      if (!card) return;
      var i = parseInt(card.getAttribute("data-lb-index"));
      if (!isNaN(i)) openAt(i);
    });

    overlay.addEventListener("click", function (e) {
      if (_ptrDownBtn) {
        _ptrDownBtn = false;
        return;
      }
      if (
        e.target === overlay ||
        e.target === slider ||
        e.target.classList.contains("lb-slide")
      )
        requestCloseFromUser();
    });
    bindPressableButton(closeBtn, requestCloseFromUser);
    prevBtn.addEventListener("click", function () {
      navigateLightboxDirection(-1);
    });
    nextBtn.addEventListener("click", function () {
      navigateLightboxDirection(1);
    });
    loadBtn.addEventListener("click", function () {
      if (animating) return;
      downloadUrl(images[idx], names[idx] || "");
      loadBtn.classList.add("success");
      setTimeout(function () {
        loadBtn.classList.remove("success");
      }, 1500);
    });
    copyBtn.addEventListener("click", function () {
      if (animating) return;
      var mediaName = names[idx] || "";
      var mediaPath = getMediaBasePath();
      copyMediaLink(mediaPath, mediaName, state.page, function () {
        copyBtn.classList.add("copied");
        setTimeout(function () {
          copyBtn.classList.remove("copied");
        }, 1500);
      });
    });

    hideBtn.addEventListener("click", function () {
      var hidden = overlay.classList.toggle("lb-hide-active");
      localStorage.setItem("gallery_lb_hidden", hidden ? "1" : "");
    });

    zoomSlider.addEventListener("input", function () {
      if (!guardZoomInteraction()) return;
      zoom = zoomSlider.value / 100;
      if (zoom <= 1) {
        panX = 0;
        panY = 0;
      }
      render();
    });
    zoomSlider.addEventListener("dblclick", function () {
      if (guardZoomInteraction()) resetZoom();
    });
    zoomLabel.addEventListener("dblclick", function () {
      if (guardZoomInteraction()) resetZoom();
    });

    document.addEventListener("pointerdown", function (e) {
      _ptrDownBtn = !!e.target.closest(".lb-btn");
    });

    document.addEventListener("mousedown", function (e) {
      if (!open || zoom <= 1) return;
      if (!guardZoomInteraction()) return;
      if (!e.target.closest(".lb-slide img, .lb-slide video")) return;
      e.preventDefault();
      isMDrag = true;
      setInteracting(true);
      mSX = e.clientX;
      mSY = e.clientY;
      mSPX = panX;
      mSPY = panY;
    });
    document.addEventListener("mousemove", function (e) {
      if (!isMDrag) return;
      if (!guardZoomInteraction()) return;
      panX = mSPX + (e.clientX - mSX);
      panY = mSPY + (e.clientY - mSY);
      render();
    });
    document.addEventListener("mouseup", function () {
      if (isMDrag) {
        isMDrag = false;
        setInteracting(false);
      }
    });

    document.addEventListener(
      "wheel",
      function (e) {
        if (!open) return;
        if (e.target.closest(".lb-slide img, .lb-slide video") || zoom > 1) {
          e.preventDefault();
          if (!guardZoomInteraction()) return;
          zoom = Math.max(
            0.5,
            Math.min(4, zoom + (e.deltaY > 0 ? -0.08 : 0.08)),
          );
          if (zoom <= 1) {
            panX = 0;
            panY = 0;
          }
          render();
        }
      },
      { passive: false },
    );

    document.addEventListener("dblclick", function (e) {
      if (!open || !e.target.closest(".lb-slide img, .lb-slide video")) return;
      e.preventDefault();
      if (!guardZoomInteraction()) return;
      zoom = zoom === 1 ? 2 : 1;
      if (zoom === 1) {
        panX = 0;
        panY = 0;
      }
      render();
    });

    document.addEventListener(
      "touchstart",
      function (e) {
        if (!open) return;
        var img = e.target.closest(".lb-slide img, .lb-slide video");
        if (!img) return;
        if (!guardZoomInteraction()) return;
        if (e.touches.length === 1) {
          var t = e.touches[0];
          tapX = t.clientX;
          tapY = t.clientY;
          if (zoom > 1) {
            e.preventDefault();
            isPanning = true;
            setInteracting(true);
            panSX = t.clientX;
            panSY = t.clientY;
            panSPX = panX;
            panSPY = panY;
          } else {
            swSX = t.clientX;
            swSY = t.clientY;
            swST = Date.now();
            isSwiping = false;
          }
        } else if (e.touches.length === 2) {
          e.preventDefault();
          isPanning = false;
          isSwiping = false;
          setInteracting(true);
          pinchDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY,
          );
          pinchZoom = zoom;
        }
      },
      { passive: false },
    );

    document.addEventListener(
      "touchmove",
      function (e) {
        if (!open) return;
        var img = e.target.closest(".lb-slide img, .lb-slide video");
        if (!img) return;
        if (!guardZoomInteraction()) return;
        if (e.touches.length === 1) {
          var t = e.touches[0];
          if (zoom > 1 && isPanning) {
            e.preventDefault();
            e.stopPropagation();
            panX = panSPX + (t.clientX - panSX);
            panY = panSPY + (t.clientY - panSY);
            render();
          } else if (zoom <= 1) {
            var dx = t.clientX - swSX,
              dy = t.clientY - swSY;
            if (!isSwiping && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10)
              isSwiping = true;
            if (isSwiping) e.preventDefault();
          }
        } else if (e.touches.length === 2) {
          e.preventDefault();
          e.stopPropagation();
          var dist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY,
          );
          zoom = Math.max(0.5, Math.min(4, pinchZoom * (dist / pinchDist)));
          if (zoom <= 1) {
            panX = 0;
            panY = 0;
          }
          render();
        }
      },
      { passive: false },
    );

    document.addEventListener(
      "touchend",
      function (e) {
        if (!open) return;
        if (!guardZoomInteraction()) return;
        if (e.touches.length < 2) pinchDist = 0;
        if (e.touches.length !== 0) return;
        setInteracting(false);
        isPanning = false;
        if (isSwiping && e.changedTouches.length === 1) {
          var t = e.changedTouches[0];
          var dx = t.clientX - swSX;
          var elapsed = Date.now() - swST;
          var absDx = Math.abs(dx);
          var velocity = absDx / Math.max(elapsed, 1);
          if (absDx > 50 || (absDx > 20 && velocity > 0.5)) {
            navigateLightboxDirection(dx < 0 ? 1 : -1);
          }
          isSwiping = false;
          lastTapT = 0;
          return;
        }
        if (e.changedTouches.length === 1) {
          var t2 = e.changedTouches[0];
          if (
            Math.abs(t2.clientX - tapX) <= 15 &&
            Math.abs(t2.clientY - tapY) <= 15
          ) {
            var now = Date.now();
            if (now - lastTapT < 300) {
              e.preventDefault();
              zoom = zoom === 1 ? 2 : 1;
              if (zoom === 1) {
                panX = 0;
                panY = 0;
              }
              render();
              lastTapT = 0;
            } else {
              lastTapT = now;
            }
          }
        }
      },
      { passive: false },
    );

    document.addEventListener("keydown", function (e) {
      if (!open && animating && e.key === "Escape") {
        e.preventDefault();
        return;
      }
      if (!open || animating) return;
      switch (e.key) {
        case "Escape":
          requestCloseFromUser();
          break;
        case "ArrowLeft":
          e.preventDefault();
          navigateLightboxDirection(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          navigateLightboxDirection(1);
          break;
        case "+":
        case "=":
          e.preventDefault();
          if (!guardZoomInteraction()) break;
          zoom = Math.min(4, zoom + 0.1);
          render();
          break;
        case "-":
          e.preventDefault();
          if (!guardZoomInteraction()) break;
          zoom = Math.max(0.5, zoom - 0.1);
          render();
          break;
      }
    });

    window.addEventListener("popstate", function (e) {
      if (fsHistoryRebaseInProgress) {
        state.suppressRoute = true;
        return;
      }
      if (open && !animating) {
        lightboxHistoryActive = false;
        state.suppressRoute = true;
        close({
          restoreScroll: true,
          clearReturnAnchor: false,
          updateHistory: false,
        });
      }
    });
  }

  return {
    init: init,
    setMedia: setMedia,
    openAt: openAt,
    close: close,
    isOpen: isOpen,
    clearReturnAnchor: clearReturnAnchor,
    beginMediaSwitch: beginMediaSwitch,
    finishMediaSwitch: finishMediaSwitch,
  };
})();

export { LB };
