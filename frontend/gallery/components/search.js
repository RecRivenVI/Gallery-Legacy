import {
  buildSearchHash,
  isDatabaseRoutePath,
  requestRouteScrollTop,
  resolveSearchSource,
  searchSourceForView,
  state,
} from "../model.js";
import { loadSearchRoute } from "../controller.js";
import { navigate, parseHash } from "../routes.js";
import { makeQueryHash } from "../query.js";
function syncSearchInputs(val) {
  var inputs = document.querySelectorAll(".search-input");
  for (var i = 0; i < inputs.length; i++) {
    if (inputs[i].value !== val) inputs[i].value = val;
    scheduleSearchInputStateSync(inputs[i]);
  }
}

function syncSearchInputState(input) {
  if (!input) return;
  var wrap = input.closest(".search-input-wrap");
  if (!wrap) return;
  var hasValue = !!input.value;

  wrap.classList.toggle("has-search-value", hasValue);
}

function scheduleSearchInputStateSync(input) {
  if (!input) return;
  requestAnimationFrame(function () {
    syncSearchInputState(input);
  });
}

function syncAllSearchInputStates() {
  var inputs = document.querySelectorAll(".search-input");
  for (var i = 0; i < inputs.length; i++) {
    scheduleSearchInputStateSync(inputs[i]);
  }
}

function syncSearchSourceIndicator(source) {
  var btns = document.querySelectorAll(".search-meta-btn");
  var resolvedSource = "db";
  var isDb = resolvedSource === "db";
  var title = "搜索作品、作者和标签；标签筛选独立生效";
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.add("meta-status");
    btns[i].classList.toggle("active", isDb);
    btns[i].classList.toggle("meta-db", isDb);
    btns[i].classList.toggle("meta-fs", !isDb);
    btns[i].setAttribute("title", title);
    btns[i].setAttribute("aria-label", title);
    btns[i].setAttribute("tabindex", "-1");
  }
}

// Legacy name; this now syncs a read-only source indicator, not a toggle.
function syncSearchMeta(source) {
  syncSearchSourceIndicator(source);
}

function initSearchInputs() {
  var inputs = document.querySelectorAll(".search-input");
  function doSearch(input) {
    var val = input.value;
    if (val) {
      var source = searchSourceForView(state.view);
      var hash = makeQueryHash(state.path, { q: val, page: 1 });
      if (typeof requestRouteScrollTop === "function") requestRouteScrollTop();
      if (window.location.hash !== "#" + hash) {
        window.location.hash = hash;
      } else {
        loadSearchRoute(state.path, val, 1, source, state.searchTag);
      }
    } else {
      location.hash = makeQueryHash(state.path, { q: "", page: 1 });
    }
    document.activeElement.blur();
  }
  for (var i = 0; i < inputs.length; i++) {
    (function (input) {
      input.addEventListener("input", function () {
        scheduleSearchInputStateSync(input);
      });
      input.addEventListener("focus", function () {
        scheduleSearchInputStateSync(input);
      });
      input.addEventListener("blur", function () {
        scheduleSearchInputStateSync(input);
      });
    })(inputs[i]);
    inputs[i].addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        doSearch(this);
      }
    });
  }
  var goBtns = document.querySelectorAll(".search-go-btn");
  for (var i = 0; i < goBtns.length; i++) {
    (function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        var wrap = btn.closest(".search-input-wrap");
        var input = wrap ? wrap.querySelector(".search-input") : null;
        if (input) doSearch(input);
      });
      btn.addEventListener("touchend", function () {
        document.activeElement.blur();
      });
    })(goBtns[i]);
  }
  var h = parseHash();
  if (h.search) syncSearchInputs(h.search);
  syncSearchSourceIndicator(
    h.source || (isDatabaseRoutePath(h.path) ? "db" : "fs"),
  );

  var metaBtns = document.querySelectorAll(".search-meta-btn");
  for (var i = 0; i < metaBtns.length; i++) {
    (function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        syncSearchSourceIndicator();
        document.activeElement.blur();
      });
      btn.addEventListener("touchend", function () {
        document.activeElement.blur();
      });
    })(metaBtns[i]);
  }

  var clearBtns = document.querySelectorAll(".search-clear-btn");
  for (var i = 0; i < clearBtns.length; i++) {
    (function (btn) {
      function doClear() {
        var wrap = btn.closest(".search-input-wrap");
        var input = wrap ? wrap.querySelector(".search-input") : null;
        if (input) {
          input.value = "";
          syncSearchInputs("");
          syncAllSearchInputStates();
          if (state.searchQuery) {
            location.hash = makeQueryHash(state.path, { q: "", page: 1 });
          }
          document.activeElement.blur();
        }
      }
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        doClear();
      });
      btn.addEventListener("touchend", function () {
        document.activeElement.blur();
      });
    })(clearBtns[i]);
  }
  syncAllSearchInputStates();
}

export { syncSearchInputs, syncSearchMeta, initSearchInputs };
