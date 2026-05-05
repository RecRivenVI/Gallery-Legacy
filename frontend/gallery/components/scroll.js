function initLabelScroll() {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

  var labels = document.querySelectorAll(".card .label");
  for (var i = 0; i < labels.length; i++) {
    (function (label) {
      if (label.scrollWidth <= label.clientWidth) return;

      var card = label.closest(".card");
      if (!card) return;

      var maxScroll = label.scrollWidth - label.clientWidth;
      var animId = null;
      var startTime = null;
      var delayId = null;
      var halfDur = 2000;
      var pause = 1000;

      function animate(ts) {
        if (!startTime) startTime = ts;
        var elapsed = (ts - startTime) % (2 * (halfDur + pause));

        var progress;
        if (elapsed < halfDur) {
          progress = elapsed / halfDur;
        } else if (elapsed < halfDur + pause) {
          progress = 1;
        } else if (elapsed < 2 * halfDur + pause) {
          progress = 1 - (elapsed - halfDur - pause) / halfDur;
        } else {
          progress = 0;
        }

        label.scrollLeft = progress * maxScroll;
        animId = requestAnimationFrame(animate);
      }

      card.addEventListener("mouseenter", function () {
        if (delayId) clearTimeout(delayId);
        delayId = setTimeout(function () {
          label.scrollLeft = 0;
          startTime = null;
          animId = requestAnimationFrame(animate);
        }, 500);
      });

      card.addEventListener("mouseleave", function () {
        if (delayId) clearTimeout(delayId);
        delayId = null;
        if (animId) cancelAnimationFrame(animId);
        animId = null;
        startTime = null;
        label.scrollLeft = 0;
      });
    })(labels[i]);
  }
}

export { initLabelScroll };

export function init() {
  (function () {
    document.documentElement.classList.add("has-cs");

    var bar = document.createElement("div");
    bar.className = "cs-bar";
    var thumb = document.createElement("div");
    thumb.className = "cs-thumb";
    bar.appendChild(thumb);
    document.body.appendChild(bar);

    var dragging = false,
      dragY = 0,
      dragTop = 0;
    var isTouch = window.matchMedia("(pointer: coarse)").matches;
    var isDesktop = window.matchMedia(
      "(hover: hover) and (pointer: fine)",
    ).matches;
    var dimOpacity = isTouch ? ".2" : ".15";
    var showOpacity = isTouch ? ".35" : ".4";

    function update() {
      var ch = document.documentElement.scrollHeight;
      var vh = window.innerHeight;
      if (ch <= vh) {
        bar.style.display = "none";
        return;
      }
      bar.style.display = "block";

      var st = window.scrollY;
      var thumbH = Math.max(20, (vh / ch) * vh);
      var maxTop = vh - 8 - thumbH;
      var top = (st / (ch - vh)) * maxTop;
      thumb.style.height = thumbH + "px";
      thumb.style.top = Math.min(maxTop, Math.max(0, top)) + "px";
    }

    var ticking = false;
    var hideTimer;
    window.addEventListener(
      "scroll",
      function () {
        if (!ticking) {
          requestAnimationFrame(function () {
            ticking = false;
            update();
          });
          ticking = true;
        }
        bar.style.opacity = showOpacity;
        clearTimeout(hideTimer);
        hideTimer = setTimeout(
          function () {
            if (!isTouch && bar.matches(":hover")) return;
            bar.style.opacity = dimOpacity;
          },
          isTouch ? 600 : 400,
        );
      },
      { passive: true },
    );

    window.addEventListener("resize", update);

    var obs = new MutationObserver(function () {
      requestAnimationFrame(update);
    });
    obs.observe(document.body, { childList: true, subtree: true });

    if (isDesktop) {
      document.addEventListener("mousemove", function (e) {
        if (e.clientX >= window.innerWidth - 20) {
          bar.style.opacity = showOpacity;
          clearTimeout(hideTimer);
        } else if (!dragging && !bar.matches(":hover")) {
          hideTimer = setTimeout(function () {
            bar.style.opacity = dimOpacity;
          }, 600);
        }
      });
      bar.addEventListener("mouseleave", function () {
        if (!dragging) {
          hideTimer = setTimeout(function () {
            bar.style.opacity = dimOpacity;
          }, 600);
        }
      });
    }

    thumb.addEventListener("mousedown", function (e) {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      dragY = e.clientY;
      dragTop = parseFloat(thumb.style.top) || 0;
      bar.classList.add("dragging");
    });

    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var vh = window.innerHeight;
      var ch = document.documentElement.scrollHeight;
      var h = parseFloat(thumb.style.height) || 20;
      var maxTop = vh - 8 - h;
      var t = Math.max(0, Math.min(maxTop, dragTop + (e.clientY - dragY)));
      thumb.style.top = t + "px";
      window.scrollTo(0, (t / maxTop) * (ch - vh));
    });

    document.addEventListener("mouseup", function () {
      if (dragging) {
        dragging = false;
        bar.classList.remove("dragging");
      }
    });

    thumb.addEventListener(
      "touchstart",
      function (e) {
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        dragY = e.touches[0].clientY;
        dragTop = parseFloat(thumb.style.top) || 0;
        bar.classList.add("dragging");
        bar.style.opacity = showOpacity;
        clearTimeout(hideTimer);
      },
      { passive: false },
    );

    document.addEventListener(
      "touchmove",
      function (e) {
        if (!dragging) return;
        e.preventDefault();
        var vh = window.innerHeight;
        var ch = document.documentElement.scrollHeight;
        var h = parseFloat(thumb.style.height) || 20;
        var maxTop = vh - 8 - h;
        var t = Math.max(
          0,
          Math.min(maxTop, dragTop + (e.touches[0].clientY - dragY)),
        );
        thumb.style.top = t + "px";
        window.scrollTo(0, (t / maxTop) * (ch - vh));
      },
      { passive: false },
    );

    document.addEventListener("touchend", function () {
      if (dragging) {
        dragging = false;
        bar.classList.remove("dragging");
        hideTimer = setTimeout(function () {
          bar.style.opacity = dimOpacity;
        }, 600);
      }
    });

    bar.addEventListener("click", function (e) {
      if (e.target === thumb) return;
      var vh = window.innerHeight;
      var ch = document.documentElement.scrollHeight;
      var h = parseFloat(thumb.style.height) || 20;
      var maxTop = vh - 8 - h;
      var t = Math.max(
        0,
        Math.min(maxTop, e.clientY - bar.getBoundingClientRect().top - h / 2),
      );
      thumb.style.top = t + "px";
      window.scrollTo(0, (t / maxTop) * (ch - vh));
    });

    update();
  })();
}
