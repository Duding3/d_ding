(function () {
  var CACHE_KEY = "main_app_version";

  function normalizeTitle(title) {
    return String(title || "").replace(/\s*v\d+(?:\.\d+)*/i, "").trim();
  }

  function applyVersion(version) {
    if (!version) return;
    var v = String(version).trim();
    if (!v) return;

    var baseTitle = normalizeTitle(document.title);
    if (baseTitle) {
      document.title = baseTitle + " v" + v;
    }

    document.querySelectorAll(".version, .app-version, #game-version, #page-version").forEach(function (el) {
      el.textContent = "v" + v;
    });

    document.querySelectorAll("h1 span").forEach(function (el) {
      var txt = String(el.textContent || "").trim();
      if (/^v\d+(?:\.\d+)*/i.test(txt)) {
        el.textContent = "v" + v;
      }
    });
  }

  function extractVersionFromIndex(html) {
    var m = String(html || "").match(/<meta\s+name=["']app-version["']\s+content=["']([^"']+)["']/i);
    return m ? String(m[1]).trim() : "";
  }

  try {
    var cached = localStorage.getItem(CACHE_KEY);
    if (cached) applyVersion(cached);
  } catch (e) {
    // no-op
  }

  fetch("index.html", { cache: "no-store" })
    .then(function (res) { return res.text(); })
    .then(function (html) {
      var latest = extractVersionFromIndex(html);
      if (!latest) return;
      try { localStorage.setItem(CACHE_KEY, latest); } catch (e) {}
      applyVersion(latest);
    })
    .catch(function () {
      // no-op
    });
})();
