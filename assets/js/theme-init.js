/* Runs before first paint: applies saved theme + language so there's no flash. */
(function () {
  try {
    var s = JSON.parse(localStorage.getItem("tadaa.settings.v1") || "{}");
    var choice = s.theme || "auto";
    var dark = choice === "dark" || (choice === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.motion = s.motion === "reduced" ? "reduced" : "full";
    if (s.lang === "en") { document.documentElement.lang = "en"; document.documentElement.dir = "ltr"; }
    var meta = document.getElementById("themeColorMeta");
    if (meta) meta.setAttribute("content", dark ? "#17142e" : "#f5f0ff");
  } catch (e) { /* first visit: defaults in markup win */ }

  /* Focus ring policy: the ring is for keyboard users only.
     `data-focus="pointer"` suppresses it for mouse/touch; `data-focus="keyboard"`
     brings it back as soon as the user navigates with the keyboard.
     Runs here (before first paint) so a click never paints a ring. */
  try {
    var root = document.documentElement;
    var NAV_KEYS = { Tab: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Home: 1, End: 1, PageUp: 1, PageDown: 1 };
    root.dataset.focus = "pointer";
    window.addEventListener("keydown", function (e) {
      if (NAV_KEYS[e.key]) root.dataset.focus = "keyboard";
    }, true);
    window.addEventListener("pointerdown", function () { root.dataset.focus = "pointer"; }, true);
  } catch (e) { /* CSS keeps its default (ring always on) if this fails */ }
})();
