var ScanWS = (function () {
  var ws = null;
  var reconnectTimer = null;
  var listeners = [];
  var openListeners = [];
  var stateListeners = [];
  var reconnectAttempt = 0;
  var reconnectCountdown = null;

  function emitState(state, detail) {
    for (var i = 0; i < stateListeners.length; i++) {
      try {
        stateListeners[i](state, detail || {});
      } catch (err) {}
    }
  }

  function getBackendWsUrl() {
    return (
      (location.protocol === "https:" ? "wss:" : "ws:") +
      "//" +
      location.host +
      "/api/v1/events"
    );
  }

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    emitState("connecting");
    try {
      ws = new WebSocket(getBackendWsUrl());
    } catch (e) {
      emitState("offline");
      scheduleReconnect();
      return;
    }
    ws.onopen = function () {
      reconnectAttempt = 0;
      if (reconnectCountdown) clearInterval(reconnectCountdown);
      emitState("online");
      for (var i = 0; i < openListeners.length; i++) {
        try {
          openListeners[i]();
        } catch (err) {}
      }
    };
    ws.onmessage = function (e) {
      try {
        var data = JSON.parse(e.data);
        if (data && data.type === "status") {
          for (var i = 0; i < listeners.length; i++) {
            try {
              listeners[i](data.data.scan);
            } catch (err) {}
          }
        }
      } catch (err) {}
    };
    ws.onclose = function () {
      emitState("offline");
      scheduleReconnect();
    };
    ws.onerror = function () {
      emitState("offline");
      ws.close();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    var delay = Math.min(30000, 3000 * Math.pow(2, reconnectAttempt++));
    var remaining = Math.ceil(delay / 1000);
    emitState("offline", { retryIn: remaining });
    if (reconnectCountdown) clearInterval(reconnectCountdown);
    reconnectCountdown = setInterval(function () {
      remaining--;
      if (remaining > 0) emitState("offline", { retryIn: remaining });
      else {
        clearInterval(reconnectCountdown);
        reconnectCountdown = null;
      }
    }, 1000);
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function reconnectNow() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (reconnectCountdown) clearInterval(reconnectCountdown);
    reconnectTimer = null;
    reconnectCountdown = null;
    reconnectAttempt = 0;
    if (ws) {
      try {
        ws.close();
      } catch (e) {}
      ws = null;
    }
    connect();
  }

  function onScanStatus(cb) {
    listeners.push(cb);
  }

  function onOpen(cb) {
    openListeners.push(cb);
  }

  function onState(cb) {
    stateListeners.push(cb);
  }

  return {
    connect: connect,
    reconnectNow: reconnectNow,
    onScanStatus: onScanStatus,
    onOpen: onOpen,
    onState: onState,
  };
})();

export { ScanWS };
