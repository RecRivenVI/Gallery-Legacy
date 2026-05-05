var GridMotion = (function () {
  // GridMotion 卡片动画，按三类 key 分流（见 renderer motionIdentityAttrs）：
  //   1) 同 motion-key（内容 + 布局都相同，仅位置变化）→ 整卡 FLIP 平移（不 scale / 不动封面文字 / 无 ghost）。
  //   2) 同 content-key、不同 motion-key（同一内容、布局变化，如 grid/compact/list 切换）→ 布局 morph：
  //        封面精准 translate+scale 连续形变（500ms）；旧 info ghost 与新 info 均在 0ms 同时启动
  //        transform + opacity，全程 500ms（不再砍半、不用 transition-delay），与封面同步连续移动。
  //   3) content-key 不同（不是同一内容）→ 旧的进入/离场：新卡 scale(.75)→1 淡入，旧卡 ghost scale(1)→.75 淡出。
  // 纯布局重排（高频 resize / sidebar）默认仍不动画，只由 scheduleGridRelayout 合并执行。
  var GRID_MOTION_DURATION_MS = 500; // 平移 / 进入 / 离场 / morph（封面 + info）统一总时长
  var GRID_MOTION_EASING = "cubic-bezier(.2,.8,.2,1)";
  var ENTER_SCALE = 0.75; // 进入起点 / 离场终点尺寸
  var MAX_MOTION_CARDS = 120; // UI 每页硬上限：浏览 / 搜索 / 作者 / 作品页均按分页限制到 120
  var MAX_VISIBLE_MOTION_CARDS = MAX_MOTION_CARDS;
  var MAX_LAYOUT_MORPH_CARDS = MAX_MOTION_CARDS;
  var MAX_GHOST_NODES = MAX_MOTION_CARDS;
  // 封面 / 信息区选择器集中定义，不在各函数散落写死。
  var CARD_COVER_SELECTOR = ".media-cover, .card-cover, [data-card-cover]";
  var CARD_INFO_SELECTOR = ".media-info, .card-info, [data-card-info]";
  var GHOST_SELECTOR =
    ".card-leaving-ghost, .card-info-morph-ghost, .grid-motion-ghost";
  var scheduledRelayout = null;
  var cleanupByNode = new WeakMap();
  var morphGhostByCard = new WeakMap();
  var morphTransformByGhost = new WeakMap();
  var gridMotionRuns = new WeakMap();
  var gridMotionRunSeq = 0;

  function transitionFor(props, durationMs) {
    var parts = [];
    durationMs = durationMs || GRID_MOTION_DURATION_MS;
    for (var i = 0; i < props.length; i++) {
      parts.push(props[i] + " " + durationMs + "ms " + GRID_MOTION_EASING);
    }
    return parts.join(", ");
  }

  function nextMotionRun(grid) {
    if (!grid) return 0;
    var seq = ++gridMotionRunSeq;
    gridMotionRuns.set(grid, seq);
    return seq;
  }

  function isCurrentMotionRun(grid, seq) {
    return !!grid && gridMotionRuns.get(grid) === seq;
  }

  function raf(fn) {
    return (
      window.requestAnimationFrame ||
      function (cb) {
        return setTimeout(cb, 16);
      }
    )(fn);
  }

  function respectReducedMotion() {
    return !!(
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function getGrid(root) {
    root = root || document;
    if (root.matches && root.matches("#content .grid")) return root;
    var grid = root.querySelector ? root.querySelector("#content .grid") : null;
    return grid || document.querySelector("#content .grid");
  }

  function isVisibleRect(rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    var pad = 120;
    return (
      rect.bottom >= -pad &&
      rect.right >= -pad &&
      rect.top <=
        (window.innerHeight || document.documentElement.clientHeight) + pad &&
      rect.left <=
        (window.innerWidth || document.documentElement.clientWidth) + pad
    );
  }

  function readCards(grid) {
    if (!grid) return [];
    return Array.prototype.slice.call(
      grid.querySelectorAll(".card[data-motion-key], .card[data-content-key]"),
    );
  }

  // ---- key 读取工具（动画 / 锚点逻辑统一从这里取，不直接读裸属性）----
  function getCardMotionKey(card) {
    if (!card || !card.getAttribute) return "";
    return card.getAttribute("data-motion-key") || "";
  }
  function getCardContentKey(card) {
    if (!card || !card.getAttribute) return "";
    var c = card.getAttribute("data-content-key");
    if (c) return c;
    var m = getCardMotionKey(card);
    var sep = m.indexOf("::");
    return sep >= 0 ? m.slice(0, sep) : m;
  }
  function getCardLayoutKey(card) {
    if (!card || !card.getAttribute) return "";
    return card.getAttribute("data-layout-key") || "";
  }
  // 返回锚点身份：默认等于 content，且永不随布局变化。锚点逻辑应基于它而非 motion key。
  function getCardAnchorKey(card) {
    if (!card || !card.getAttribute) return "";
    return card.getAttribute("data-anchor-key") || getCardContentKey(card);
  }
  function findCardByAnchorKey(grid, anchorKey) {
    grid = grid || getGrid();
    if (!grid || !anchorKey) return null;
    var cards = readCards(grid);
    for (var i = 0; i < cards.length; i++) {
      if (getCardAnchorKey(cards[i]) === anchorKey) return cards[i];
    }
    return null;
  }

  function markGridReady(grid) {
    if (grid) grid.classList.add("grid-motion-ready");
  }

  // ---- 清理 ----
  // 清掉单卡所有 inline 痕迹与动画类（含封面 / 信息区，覆盖 FLIP / 进入 / morph 三类）。
  function finalizeCard(card) {
    if (!card) return;
    card.classList.remove(
      "card-layout-animating",
      "card-entering",
      "card-layout-morphing",
    );
    clearNodeMotionStyle(card);
    var cover = card.querySelector
      ? card.querySelector(CARD_COVER_SELECTOR)
      : null;
    if (cover) {
      cover.classList.remove("card-cover-morphing");
      clearNodeMotionStyle(cover);
    }
    var info = card.querySelector
      ? card.querySelector(CARD_INFO_SELECTOR)
      : null;
    if (info) {
      info.classList.remove("card-info-morph-new");
      clearNodeMotionStyle(info);
    }
    var ghost = morphGhostByCard.get(card);
    if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
    cleanupByNode.delete(card);
    morphGhostByCard.delete(card);
  }

  function clearNodeMotionStyle(node) {
    if (!node || !node.style) return;
    node.style.transform = "";
    node.style.transition = "";
    node.style.opacity = "";
    node.style.willChange = "";
    node.style.transformOrigin = "";
    node.style.zIndex = "";
  }

  function clearCardMotion(card) {
    if (!card) return;
    var cleanup = cleanupByNode.get(card);
    if (cleanup) {
      cleanup();
      return;
    }
    finalizeCard(card);
  }

  // 移除所有 motion ghost，并 finalize 仍残留动画类的卡片。每次 mutation 开始前调用，
  // 兜底页面失焦 / timer 节流导致上一轮 ghost / inline 未清理的情况。
  function cleanupAllMotionArtifacts(root) {
    root = root || document;
    var ghosts = root.querySelectorAll(GHOST_SELECTOR);
    for (var i = 0; i < ghosts.length; i++) {
      if (ghosts[i].parentNode) ghosts[i].parentNode.removeChild(ghosts[i]);
    }
    var lingering = root.querySelectorAll(
      ".card-layout-animating, .card-entering, .card-layout-morphing",
    );
    for (var j = 0; j < lingering.length; j++) clearCardMotion(lingering[j]);
  }

  // 监听某节点指定属性过渡结束（带超时兜底），结束即执行 onDone。
  function watchNode(
    node,
    watchTarget,
    propertyName,
    durationMs,
    onDone,
    isCurrent,
  ) {
    var done = false;
    var timer = null;
    function cleanup(e, force) {
      if (
        e &&
        (e.target !== watchTarget ||
          (propertyName && e.propertyName !== propertyName))
      )
        return;
      if (done) return;
      if (!force && isCurrent && !isCurrent()) return;
      done = true;
      watchTarget.removeEventListener("transitionend", cleanup);
      if (timer) clearTimeout(timer);
      cleanupByNode.delete(node);
      onDone();
    }
    cleanupByNode.set(node, function () {
      cleanup(null, true);
    });
    watchTarget.addEventListener("transitionend", cleanup);
    timer = setTimeout(cleanup, durationMs + 120);
  }

  // ---- 进入：整卡 scale(.75)+opacity:0 → scale(1)+opacity:1（content key 不同的新卡）----
  function prepareCardEnter(card) {
    card.classList.add("card-entering");
    card.style.transformOrigin = "center center";
    card.style.transition = "none";
    card.style.transform = "scale(" + ENTER_SCALE + ")";
    card.style.opacity = "0";
    card.style.willChange = "transform, opacity";
    card.style.zIndex = "1";
  }
  function commitCardEnter(card, durationMs) {
    var grid = card.closest ? card.closest("#content .grid") : null;
    var runSeq = grid ? gridMotionRuns.get(grid) : 0;
    card.style.transition = transitionFor(["transform", "opacity"], durationMs);
    card.style.transform = "scale(1)";
    card.style.opacity = "1";
    watchNode(
      card,
      card,
      "transform",
      durationMs,
      function () {
        finalizeCard(card);
      },
      function () {
        return !grid || isCurrentMotionRun(grid, runSeq);
      },
    );
  }

  // ---- 同 motion-key 承接：仅 translate 反向位移，再平滑归位（不 scale / 不动封面文字）----
  function prepareCardFlip(card, dx, dy) {
    card.classList.add("card-layout-animating");
    card.style.transition = "none";
    card.style.transform = "translate(" + dx + "px, " + dy + "px)";
    card.style.opacity = "1";
    card.style.willChange = "transform";
    card.style.zIndex = "1";
  }
  function commitCardFlip(card, durationMs) {
    var grid = card.closest ? card.closest("#content .grid") : null;
    var runSeq = grid ? gridMotionRuns.get(grid) : 0;
    card.style.transition = transitionFor(["transform"], durationMs);
    card.style.transform = "";
    watchNode(
      card,
      card,
      "transform",
      durationMs,
      function () {
        finalizeCard(card);
      },
      function () {
        return !grid || isCurrentMotionRun(grid, runSeq);
      },
    );
  }

  // ---- 离场 ghost：在原位克隆整卡，scale(1)→scale(.75) 淡出后移除（content key 消失）----
  function buildLeaveGhost(record) {
    if (!record || !record.cardRect) return null;
    var rect = record.cardRect;
    var clone = record.clone
      ? record.clone
      : record.card
        ? record.card.cloneNode(true)
        : null;
    if (!clone) return null;
    sanitizeGhostClone(clone);
    clone.classList.add("card-leaving-ghost", "grid-motion-ghost");
    if (String(record.layoutKey || "").indexOf("list") === 0)
      clone.classList.add("grid-motion-list-ghost");
    if (String(record.layoutKey || "").indexOf("compact") === 0)
      clone.classList.add("grid-motion-compact-ghost");
    clone.style.position = "fixed";
    clone.style.left = rect.left + "px";
    clone.style.top = rect.top + "px";
    clone.style.width = rect.width + "px";
    clone.style.height = rect.height + "px";
    clone.style.margin = "0";
    clone.style.pointerEvents = "none";
    clone.style.zIndex = "1200";
    clone.style.transformOrigin = "center center";
    clone.style.opacity = "1";
    clone.style.transform = "scale(1)";
    clone.style.transition = "none";
    clone.style.animation = "none";
    document.body.appendChild(clone);
    clone.getBoundingClientRect();
    return clone;
  }
  function commitLeaveGhost(clone, durationMs, grid, runSeq) {
    raf(function () {
      if (grid && !isCurrentMotionRun(grid, runSeq)) return;
      clone.style.transition = transitionFor(
        ["transform", "opacity"],
        durationMs,
      );
      clone.style.transform = "scale(" + ENTER_SCALE + ")";
      clone.style.opacity = "0";
    });
    setTimeout(function () {
      if (grid && !isCurrentMotionRun(grid, runSeq)) return;
      if (clone.parentNode) clone.parentNode.removeChild(clone);
    }, durationMs + 80);
  }

  // ghost 是纯视觉残影：移除 id / 全部 data-*（含 data-lb-index / data-*-key），避免被灯箱索引或卡片选择器误判；
  // aria-hidden 隐藏于无障碍树。返回锚点 / 灯箱定位都不会命中 ghost。
  function sanitizeGhostClone(clone) {
    clone.classList.remove(
      "card-layout-animating",
      "card-entering",
      "card-layout-morphing",
      "entrance",
      "lb-return-highlight",
    );
    clone.removeAttribute("id");
    var attrs = clone.attributes;
    for (var ai = attrs.length - 1; ai >= 0; ai--) {
      if (attrs[ai].name.indexOf("data-") === 0)
        clone.removeAttribute(attrs[ai].name);
    }
    clone.setAttribute("aria-hidden", "true");
  }

  // ---- 布局 morph：同 content-key、不同 motion-key（封面 scale + info 半程切换）----
  // 返回 'morph' | 'flip' | 'none'，供调用方决定收尾方式。
  function prepareCardMorph(card, oldSnap, oldGridClass, ghostBudget) {
    var cover = card.querySelector(CARD_COVER_SELECTOR);
    var newCardRect = card.getBoundingClientRect();
    // 封面缺失或旧封面 rect 缺失：降级为普通整卡 translate（不做内部 morph）。
    if (!cover || !oldSnap.coverRect || !oldSnap.cardRect) {
      var fdx = oldSnap.cardRect ? oldSnap.cardRect.left - newCardRect.left : 0;
      var fdy = oldSnap.cardRect ? oldSnap.cardRect.top - newCardRect.top : 0;
      if (Math.abs(fdx) < 0.5 && Math.abs(fdy) < 0.5) return "none";
      prepareCardFlip(card, fdx, fdy);
      return "flip";
    }
    var newCoverRect = cover.getBoundingClientRect();
    if (newCoverRect.width <= 0 || newCoverRect.height <= 0) return "none";
    card.classList.add("card-layout-morphing");
    var sx = oldSnap.coverRect.width / newCoverRect.width;
    var sy = oldSnap.coverRect.height / newCoverRect.height;
    var cdx = oldSnap.coverRect.left - newCoverRect.left;
    var cdy = oldSnap.coverRect.top - newCoverRect.top;
    cover.classList.add("card-cover-morphing");
    cover.style.transformOrigin = "top left";
    cover.style.transition = "none";
    cover.style.transform =
      "translate(" + cdx + "px, " + cdy + "px) scale(" + sx + ", " + sy + ")";
    cover.style.willChange = "transform";

    // 非封面内容沿统一路径 oldInfoRect → newInfoRect 平移（不自身 scale）：
    //   新 info：起点对齐旧 info 旧绝对位置（translate(infoPathDx,Dy)）→ 终点 newInfoRect（none），opacity 0→1；
    //   旧 info ghost：起点旧 info 旧绝对位置（translate 0）→ 终点 newInfoRect（translate(-infoPathDx,-Dy)），opacity 1→0。
    //   两者同一条路径、方向相反、同步淡入淡出，避免“旧元素原地消失、新元素滑入”的割裂。
    var info = card.querySelector(CARD_INFO_SELECTOR);
    var hasInfoPath = false,
      infoPathDx = 0,
      infoPathDy = 0;
    if (info && oldSnap.infoRect) {
      var newInfoRect = info.getBoundingClientRect();
      infoPathDx = oldSnap.infoRect.left - newInfoRect.left;
      infoPathDy = oldSnap.infoRect.top - newInfoRect.top;
      hasInfoPath = true;
      info.classList.add("card-info-morph-new");
      info.style.transition = "none";
      info.style.opacity = "0";
      info.style.transform =
        "translate(" + infoPathDx + "px, " + infoPathDy + "px)";
      info.style.willChange = "transform, opacity";
    }
    // 旧 info ghost：克隆整卡、隐藏封面，挂在旧布局 grid 容器下（保证旧视图样式），固定在旧卡片位置。
    if (ghostBudget.count < MAX_GHOST_NODES) {
      var ghost = buildMorphInfoGhost(oldSnap, oldGridClass);
      if (ghost) {
        // 终点沿新 info 同一路径反向位移（ghost wrap 整体平移，内部旧 info 从 oldInfoRect 移到 newInfoRect）。
        morphTransformByGhost.set(
          ghost,
          hasInfoPath
            ? "translate(" + -infoPathDx + "px, " + -infoPathDy + "px)"
            : "",
        );
        morphGhostByCard.set(card, ghost);
        ghostBudget.count++;
      }
    }
    return "morph";
  }

  function buildMorphInfoGhost(snap, oldGridClass) {
    if (!snap.clone || !snap.cardRect) return null;
    var rect = snap.cardRect;
    var wrap = document.createElement("div");
    wrap.className =
      (oldGridClass || "grid") + " grid-motion-ghost card-info-morph-ghost";
    wrap.setAttribute("aria-hidden", "true");
    wrap.style.position = "fixed";
    wrap.style.left = rect.left + "px";
    wrap.style.top = rect.top + "px";
    wrap.style.width = rect.width + "px";
    wrap.style.height = rect.height + "px";
    // ghost wrap 只容纳一张卡片，且宽度已固定为单卡宽。这里强制单列，覆盖 .grid 的响应式
    // 列模板（移动端 .grid 媒体查询硬编码 repeat(2,…)，会把克隆卡挤成半宽、导致旧 info 偏上）。
    wrap.style.gridTemplateColumns = "minmax(0, 1fr)";
    wrap.style.margin = "0";
    wrap.style.padding = "0";
    wrap.style.pointerEvents = "none";
    wrap.style.zIndex = "1190";
    wrap.style.opacity = "1";
    wrap.style.transform = "translate(0px, 0px)"; // 起点对齐旧 info 绝对位置，commit 时沿路径平移并淡出
    wrap.style.transition = "none";
    var clone = snap.clone;
    var cv = clone.querySelector(CARD_COVER_SELECTOR);
    if (cv) cv.style.visibility = "hidden"; // 封面由真实卡片承接 morph，ghost 只保留旧 info 视觉
    wrap.appendChild(clone);
    document.body.appendChild(wrap);
    wrap.getBoundingClientRect();
    return wrap;
  }

  function commitCardMorph(card, durationMs) {
    var grid = card.closest ? card.closest("#content .grid") : null;
    var runSeq = grid ? gridMotionRuns.get(grid) : 0;
    var cover = card.querySelector(CARD_COVER_SELECTOR);
    var info = card.querySelector(CARD_INFO_SELECTOR);
    if (cover) {
      cover.style.transition = transitionFor(["transform"], durationMs);
      cover.style.transform = "";
    }
    // 新 info：opacity 与 transform 在 0ms 同时启动，全程 500ms（无 transition-delay、不砍半）。
    if (info && info.classList.contains("card-info-morph-new")) {
      info.style.transition = transitionFor(
        ["opacity", "transform"],
        durationMs,
      );
      info.style.opacity = "1";
      info.style.transform = "";
    }
    // 旧 info ghost：opacity 与 transform 0ms 同步启动，全程 500ms；沿新 info 同一路径反向平移并淡出后移除。
    var ghost = morphGhostByCard.get(card);
    if (ghost) {
      var ghostTransform = morphTransformByGhost.get(ghost) || "";
      raf(function () {
        if (grid && !isCurrentMotionRun(grid, runSeq)) return;
        ghost.style.transition = transitionFor(
          ["opacity", "transform"],
          durationMs,
        );
        ghost.style.opacity = "0";
        if (ghostTransform) ghost.style.transform = ghostTransform;
      });
      setTimeout(function () {
        if (grid && !isCurrentMotionRun(grid, runSeq)) return;
        if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
        morphTransformByGhost.delete(ghost);
      }, durationMs + 80);
      morphGhostByCard.delete(card);
    }
    var watchTarget = cover || card;
    watchNode(
      card,
      watchTarget,
      "transform",
      durationMs,
      function () {
        finalizeCard(card);
      },
      function () {
        return !grid || isCurrentMotionRun(grid, runSeq);
      },
    );
  }

  // ---- 捕获旧状态：keyed rect 快照（含封面 / 信息区 rect，可选整卡克隆供 morph / leave ghost）----
  function captureCardSnapshot(card, orderIndex, options) {
    options = options || {};
    var cardRect = card.getBoundingClientRect();
    var captureMorphDetails = !!options.captureMorphDetails;
    var coverEl = captureMorphDetails
      ? card.querySelector(CARD_COVER_SELECTOR)
      : null;
    var infoEl = captureMorphDetails
      ? card.querySelector(CARD_INFO_SELECTOR)
      : null;
    var snap = {
      motionKey: getCardMotionKey(card),
      contentKey: getCardContentKey(card),
      layoutKey: getCardLayoutKey(card),
      anchorKey: getCardAnchorKey(card),
      card: card,
      cardRect: cardRect,
      coverRect: coverEl ? coverEl.getBoundingClientRect() : null,
      infoRect: infoEl ? infoEl.getBoundingClientRect() : null,
      visible: isVisibleRect(cardRect),
      orderIndex: orderIndex,
      consumed: false,
      clone: null,
    };
    // 仅在需要时（布局 mutation：DOM 复用或被替换前）克隆旧外观，作为 morph 旧 info / leave ghost 源。
    if (options.captureClones && snap.visible) {
      var clone = card.cloneNode(true);
      sanitizeGhostClone(clone);
      snap.clone = clone;
    }
    return snap;
  }

  function captureGridState(grid, options) {
    options = options || {};
    var captureClones = !!options.captureClones;
    var captureMorphDetails = !!options.captureMorphDetails || captureClones;
    var cards = readCards(grid);
    var byMotionKey = {};
    var byContentKey = {};
    var ordered = [];
    var visibleCount = 0;
    for (var i = 0; i < cards.length; i++) {
      var snap = captureCardSnapshot(cards[i], ordered.length, {
        captureClones: captureClones,
        captureMorphDetails: captureMorphDetails,
      });
      if (!snap.motionKey && !snap.contentKey) continue;
      if (snap.motionKey && byMotionKey[snap.motionKey]) continue; // 同 motion key 去重
      if (snap.visible) visibleCount++;
      if (snap.motionKey) byMotionKey[snap.motionKey] = snap;
      if (snap.contentKey) {
        (byContentKey[snap.contentKey] =
          byContentKey[snap.contentKey] || []).push(snap);
      }
      ordered.push(snap);
    }
    return {
      grid: grid,
      gridClass: grid ? grid.className : "grid",
      byMotionKey: byMotionKey,
      byContentKey: byContentKey,
      ordered: ordered,
      total: ordered.length,
      visibleCount: visibleCount,
      large: ordered.length > MAX_MOTION_CARDS,
    };
  }

  function pickContentCandidate(previousState, contentKey, motionKey) {
    var list = previousState.byContentKey[contentKey];
    if (!list) return null;
    for (var i = 0; i < list.length; i++) {
      // 同内容但布局（motion key）不同、且尚未被其它新卡消费 → 可做 morph 承接。
      if (!list[i].consumed && list[i].motionKey !== motionKey) return list[i];
    }
    return null;
  }

  // 核心分类与编排。previousState 为 mutate 前快照；flags 决定允许哪些动画。
  function playGridFlip(grid, previousState, options) {
    options = options || {};
    if (!grid) return;
    markGridReady(grid);
    var runSeq = nextMotionRun(grid);
    if (respectReducedMotion()) {
      grid.classList.add("grid-motion-disabled");
      return;
    }
    grid.classList.remove("grid-motion-disabled");
    previousState = previousState || {
      byMotionKey: {},
      byContentKey: {},
      ordered: [],
      total: 0,
      visibleCount: 0,
      large: false,
      gridClass: "grid",
    };

    var allowEnterLeave = options.allowEnterLeave !== false;
    var allowMorph = !!options.allowLayoutMorph;
    var allowFlip = options.allowPositionFlip !== false;
    var flipDuration = options.duration || GRID_MOTION_DURATION_MS;
    var enterDuration = options.enterDuration || GRID_MOTION_DURATION_MS;
    var leaveDuration = options.leaveDuration || GRID_MOTION_DURATION_MS;
    var cards = readCards(grid);
    var newContentKeys = {};
    var staying = [];
    var entering = [];
    var morphing = [];
    var visibleAnimated = 0;
    var morphCount = 0;
    var ghostBudget = { count: 0 };
    var enterLeaveEnabled =
      allowEnterLeave &&
      !previousState.large &&
      cards.length <= MAX_MOTION_CARDS;

    for (var c = 0; c < cards.length; c++) clearCardMotion(cards[c]);

    for (var j = 0; j < cards.length; j++) {
      var card = cards[j];
      var motionKey = getCardMotionKey(card);
      var contentKey = getCardContentKey(card);
      if (!motionKey && !contentKey) continue;
      if (contentKey) newContentKeys[contentKey] = true;
      var rect = card.getBoundingClientRect();
      if (!isVisibleRect(rect)) continue;
      if (visibleAnimated >= MAX_VISIBLE_MOTION_CARDS) continue;

      var sameMotion = motionKey ? previousState.byMotionKey[motionKey] : null;
      if (sameMotion) {
        // 情况 1：同 motion key，仅位移。
        if (!allowFlip) continue;
        var dx = sameMotion.cardRect.left - rect.left;
        var dy = sameMotion.cardRect.top - rect.top;
        if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
          staying.push({ card: card, dx: dx, dy: dy });
          visibleAnimated++;
        }
        continue;
      }

      var candidate = pickContentCandidate(
        previousState,
        contentKey,
        motionKey,
      );
      if (candidate) {
        // 情况 2：同 content、不同 layout。即使 morph 禁用 / 超 cap / 资源不足，也不能误判为全新内容进入。
        candidate.consumed = true;
        if (allowMorph && morphCount < MAX_LAYOUT_MORPH_CARDS) {
          morphing.push({ card: card, oldSnap: candidate });
          morphCount++;
        } else if (allowFlip && candidate.cardRect) {
          var cdx = candidate.cardRect.left - rect.left;
          var cdy = candidate.cardRect.top - rect.top;
          if (Math.abs(cdx) >= 0.5 || Math.abs(cdy) >= 0.5) {
            staying.push({ card: card, dx: cdx, dy: cdy });
          }
        }
        visibleAnimated++;
        continue;
      }

      if (enterLeaveEnabled) {
        // 情况 3：全新内容 → 进入。
        entering.push(card);
        visibleAnimated++;
      }
    }

    // 离场：旧内容 key 在新网格中完全消失（同内容换布局不算离场，由 morph / stay 承接）。
    var leaving = [];
    if (enterLeaveEnabled) {
      for (var k = 0; k < previousState.ordered.length; k++) {
        var rec = previousState.ordered[k];
        if (rec.consumed) continue;
        if (rec.contentKey && newContentKeys[rec.contentKey]) continue;
        if (!rec.visible) continue;
        if (ghostBudget.count >= MAX_GHOST_NODES) break;
        var ghost = buildLeaveGhost(rec);
        if (ghost) {
          leaving.push({ ghost: ghost });
          ghostBudget.count++;
        }
      }
    }

    // 同帧批量前置初始状态，统一 reflow 后再 commit，避免多次重排。
    var morphResults = [];
    for (var m = 0; m < morphing.length; m++) {
      var kind = prepareCardMorph(
        morphing[m].card,
        morphing[m].oldSnap,
        previousState.gridClass,
        ghostBudget,
      );
      if (kind !== "none")
        morphResults.push({ card: morphing[m].card, kind: kind });
    }
    for (var s = 0; s < staying.length; s++)
      prepareCardFlip(staying[s].card, staying[s].dx, staying[s].dy);
    for (var e = 0; e < entering.length; e++) prepareCardEnter(entering[e]);

    if (
      !staying.length &&
      !entering.length &&
      !morphResults.length &&
      !leaving.length
    )
      return;
    grid.getBoundingClientRect();

    raf(function () {
      if (!isCurrentMotionRun(grid, runSeq)) return;
      for (var mr = 0; mr < morphResults.length; mr++) {
        if (morphResults[mr].kind === "morph")
          commitCardMorph(morphResults[mr].card, flipDuration);
        else commitCardFlip(morphResults[mr].card, flipDuration);
      }
      for (var a = 0; a < staying.length; a++)
        commitCardFlip(staying[a].card, flipDuration);
      for (var b = 0; b < entering.length; b++)
        commitCardEnter(entering[b], enterDuration);
    });
    for (var lg = 0; lg < leaving.length; lg++)
      commitLeaveGhost(leaving[lg].ghost, leaveDuration, grid, runSeq);
  }

  // ===== 统一核心：capture → mutate → afterMutate → 分类播放 =====
  function animateGridMutationCore(grid, mutator, options) {
    options = options || {};
    var root = options.root || document;
    grid = grid || getGrid(root);
    if (grid) nextMotionRun(grid);
    cleanupAllMotionArtifacts(); // 每次 mutation 前兜底清残留

    if (respectReducedMotion()) {
      if (document.documentElement)
        document.documentElement.classList.add("grid-motion-disabled");
      mutator();
      var reducedGrid = getGrid(root);
      if (typeof options.afterMutate === "function")
        options.afterMutate(reducedGrid);
      markGridReady(reducedGrid);
      if (reducedGrid) reducedGrid.classList.add("grid-motion-disabled");
      return reducedGrid;
    }

    if (document.documentElement)
      document.documentElement.classList.remove("grid-motion-disabled");
    var previousState = grid
      ? captureGridState(grid, { captureClones: !!options.captureClones })
      : null;
    mutator();
    var nextGrid = getGrid(root);
    if (typeof options.afterMutate === "function")
      options.afterMutate(nextGrid);
    if (nextGrid) {
      playGridFlip(nextGrid, previousState, {
        allowEnterLeave: options.allowEnterLeave,
        allowLayoutMorph: options.allowLayoutMorph,
        allowPositionFlip: options.allowPositionFlip,
        duration: options.duration,
        enterDuration: options.enterDuration,
        leaveDuration: options.leaveDuration,
      });
    }
    return nextGrid;
  }

  // 数据变化入口：进入 / 离场 / 同 motion key 承接（布局 key 不变 → 不产生 morph）。
  function animateDataMutation(mutator, options) {
    options = options || {};
    return animateGridMutationCore(
      options.grid || getGrid(options.root || document),
      mutator,
      {
        root: options.root,
        afterMutate: options.afterMutate,
        allowEnterLeave: true,
        allowLayoutMorph: false,
        allowPositionFlip: true,
        captureClones: false,
        duration: options.duration,
        enterDuration: options.enterDuration,
        leaveDuration: options.leaveDuration,
      },
    );
  }

  // 布局变化入口：同 content 不同 layout → morph；位置变化 → 平移。需捕获旧外观克隆。
  function animateLayoutMutation(grid, mutator, options) {
    options = options || {};
    return animateGridMutationCore(
      grid || getGrid(options.root || document),
      mutator,
      {
        root: options.root,
        afterMutate: options.afterMutate,
        allowEnterLeave: options.allowEnterLeave !== false,
        allowLayoutMorph: options.allowLayoutMorph !== false,
        allowPositionFlip: true,
        captureClones: true,
        duration: options.duration,
      },
    );
  }

  // 混合变化入口：同一次 mutation 内允许数据进入/离场、同内容布局 morph、同 key 位移。
  // 用于布局 / 宽度 / 页容量等状态同时变化后的一次性重渲染。
  function animateMixedMutation(mutator, options) {
    options = options || {};
    return animateGridMutationCore(
      options.grid || getGrid(options.root || document),
      mutator,
      {
        root: options.root,
        afterMutate: options.afterMutate,
        allowEnterLeave: true,
        allowLayoutMorph: true,
        allowPositionFlip: true,
        captureClones: true,
        duration: options.duration,
        enterDuration: options.enterDuration,
        leaveDuration: options.leaveDuration,
      },
    );
  }

  // 数据渲染：替换 grid HTML 并做数据动画。motion:"none" 时直接替换不动画。
  function replaceGridWithMotion(contentEl, nextHtml, options) {
    options = options || {};
    if (options.motion === "none") {
      var oldGrid = getGrid(contentEl);
      if (oldGrid) nextMotionRun(oldGrid);
      cleanupAllMotionArtifacts();
      if (typeof options.beforeMutate === "function") options.beforeMutate();
      contentEl.innerHTML = nextHtml;
      var g = getGrid(contentEl);
      markGridReady(g);
      if (typeof options.afterMutate === "function") options.afterMutate(g);
      return g;
    }
    var runner = options.allowLayoutMorph
      ? animateMixedMutation
      : animateDataMutation;
    return runner(
      function () {
        if (typeof options.beforeMutate === "function") options.beforeMutate();
        contentEl.innerHTML = nextHtml;
      },
      {
        root: contentEl,
        afterMutate: options.afterMutate,
        duration: options.duration,
        enterDuration: options.enterDuration,
        leaveDuration: options.leaveDuration,
      },
    );
  }

  // ===== 纯布局重排入口：rAF 合并，只立即重排（列数 + 标签裁剪）=====
  // 生产调用方为 resize / sidebar；高频事件只合并网格列与标签重排。
  function scheduleGridRelayout(root) {
    root = root || document;
    if (scheduledRelayout) {
      scheduledRelayout.root = root || scheduledRelayout.root;
      return;
    }
    scheduledRelayout = { root: root };
    raf(function () {
      var job = scheduledRelayout;
      scheduledRelayout = null;
      if (window.applyGridColumnsRaw) window.applyGridColumnsRaw(job.root);
      else if (window.applyGridColumns) window.applyGridColumns(job.root);
      if (window.syncCardTags) window.syncCardTags(job.root);
    });
  }

  return {
    // 捕获 / 分类
    captureGridState: captureGridState,
    playGridFlip: playGridFlip,
    // 数据变化（有进入 / 离场 / 平移）
    animateDataMutation: animateDataMutation,
    replaceGridWithMotion: replaceGridWithMotion,
    // 布局变化（morph / 平移）
    animateLayoutMutation: animateLayoutMutation,
    // 混合变化（数据进入/离场 + layout morph + 平移）
    animateMixedMutation: animateMixedMutation,
    // 纯布局（默认无动画）
    scheduleGridRelayout: scheduleGridRelayout,
    // 工具
    respectReducedMotion: respectReducedMotion,
    markGridReady: markGridReady,
    cleanupAllMotionArtifacts: cleanupAllMotionArtifacts,
    // key 读取（锚点 / 灯箱应基于 anchor / content，不依赖 motion key）
    getCardMotionKey: getCardMotionKey,
    getCardContentKey: getCardContentKey,
    getCardLayoutKey: getCardLayoutKey,
    getCardAnchorKey: getCardAnchorKey,
    findCardByAnchorKey: findCardByAnchorKey,
  };
})();

export { GridMotion };
