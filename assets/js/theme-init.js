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
})();
