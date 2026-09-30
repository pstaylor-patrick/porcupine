// Applies the stored theme before first paint and wires button.theme-toggle.
// Loaded synchronously in <head>, not bundled, so CSP script-src 'self' holds.
(function () {
  var KEY = "porcupine-theme";
  var COLORS = { light: "#f6efe0", dark: "#24122a" };
  var root = document.documentElement;

  function stored() {
    try {
      var v = window.sessionStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : null;
    } catch {
      return null;
    }
  }

  function effective() {
    var t = root.dataset.theme;
    if (t === "light" || t === "dark") return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function sync() {
    var next = effective() === "dark" ? "light" : "dark";
    var buttons = document.querySelectorAll("button.theme-toggle");
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      b.setAttribute("aria-label", "Switch to " + next + " theme");
      var icons = b.querySelectorAll("[data-icon]");
      for (var j = 0; j < icons.length; j++) {
        var show = icons[j].getAttribute("data-icon") === (next === "dark" ? "moon" : "sun");
        if (show) icons[j].removeAttribute("hidden");
        else icons[j].setAttribute("hidden", "");
      }
    }
  }

  function setMetas(theme) {
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute("content", COLORS[theme]);
  }

  function toggle() {
    var next = effective() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
      window.sessionStorage.setItem(KEY, next);
    } catch {
      // storage blocked: the choice lasts for this page only
    }
    setMetas(next);
    sync();
  }

  function bind() {
    var buttons = document.querySelectorAll("button.theme-toggle");
    for (var i = 0; i < buttons.length; i++) buttons[i].addEventListener("click", toggle);
    sync();
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      if (mq.addEventListener) mq.addEventListener("change", sync);
    }
  }

  var initial = stored();
  if (initial) {
    root.dataset.theme = initial;
    if (document.head) setMetas(initial);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
