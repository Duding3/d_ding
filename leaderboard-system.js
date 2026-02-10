(function () {
  const GAME_META = {
    jump: { name: "슬라임 점프", unit: "m" },
    tetris: { name: "테트리스", unit: "" },
    snake: { name: "네온 스네이크", unit: "" },
    memory: { name: "메모리 매치", unit: "Lv" },
    blockBlast: { name: "블록블라스트", unit: "" },
    catch: { name: "클라운 캐치", unit: "" },
    stack: { name: "퍼펙트 타워", unit: "층" },
    dodge: { name: "코스믹 닷지", unit: "s" },
    dino: { name: "달려달려", unit: "" }
  };

  const LOCAL_KEY = "hof_local_rankings_v1";
  const NAME_KEY = "hof_player_name";
  const GLOBAL_VERSION_KEY = "main_app_version";
  const AUTH_CACHE_KEY = "hof_auth_cache_v1";
  const TOP3_CACHE_ROOT = "leaderboards_top3";
  const TOP_SCORES_PERSIST_KEY = "hof_top_scores_cache_v1";
  const USER_PROFILE_ROOT = "userProfiles";
  const NICKNAME_LIMIT_LOCAL_KEY = "hof_nickname_limit_local_v1";
  const NICKNAME_COOLDOWN_MS = 30 * 1000;
  const NICKNAME_DAILY_LIMIT = 2;
  const REQUIRE_AUTH_FOR_WRITE = true;

  let firebaseReady = false;
  let firebaseLoadAttempted = false;
  let firebaseEnsurePromise = null;
  let firebaseDisabledReason = "";
  let authInitDone = false;
  let authStateKnown = false;
  let currentUser = null;
  const authSubscribers = [];
  const userNicknameCache = {};

  function toDayKey(ts) {
    const d = new Date(Number(ts) || Date.now());
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function normalizeTitleWithoutVersion(title) {
    return String(title || "").replace(/\s*v\d+(?:\.\d+)*/i, "").trim();
  }

  function applyGlobalVersionToPage(version) {
    const v = String(version || "").trim();
    if (!v) return;

    const baseTitle = normalizeTitleWithoutVersion(document.title);
    if (baseTitle) {
      document.title = baseTitle + " v" + v;
    }

    try {
      document.querySelectorAll(".version, .app-version, #game-version, #page-version").forEach((el) => {
        el.textContent = "v" + v;
      });

      document.querySelectorAll("h1 span").forEach((el) => {
        const txt = String(el.textContent || "").trim();
        if (/^v\d+(?:\.\d+)*/i.test(txt)) {
          el.textContent = "v" + v;
        }
      });
    } catch (err) {
      // no-op
    }
  }

  function syncGlobalVersionFromIndex() {
    try {
      const cached = localStorage.getItem(GLOBAL_VERSION_KEY);
      if (cached) applyGlobalVersionToPage(cached);
    } catch (err) {
      // no-op
    }

    fetch("index.html", { cache: "no-store" })
      .then((res) => res.text())
      .then((html) => {
        const m = String(html || "").match(/<meta\s+name=["']app-version["']\s+content=["']([^"']+)["']/i);
        const latest = m ? String(m[1]).trim() : "";
        if (!latest) return;
        try {
          localStorage.setItem(GLOBAL_VERSION_KEY, latest);
        } catch (err) {
          // no-op
        }
        applyGlobalVersionToPage(latest);
      })
      .catch(() => {
        // no-op
      });
  }

  function readJSON(storageKey, fallbackValue) {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return fallbackValue;
      return JSON.parse(raw);
    } catch (err) {
      return fallbackValue;
    }
  }

  function writeJSON(storageKey, value) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (err) {
      // no-op
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector('script[src="' + src + '"]');
      if (existing) {
        // If the script tag already exists in HTML, treat it as usable immediately.
        // Waiting for a new "load" event here can hang because the event may have already fired.
        if (existing.dataset.loaded === "1" || existing.readyState === "loaded" || existing.readyState === "complete") {
          resolve();
          return;
        }
        resolve();
        return;
      }

      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => {
        script.dataset.loaded = "1";
        resolve();
      };
      script.onerror = () => reject(new Error("Failed to load: " + src));
      document.head.appendChild(script);
    });
  }

  async function ensureFirebase() {
    if (firebaseReady) return true;
    if (firebaseEnsurePromise) return firebaseEnsurePromise;

    firebaseEnsurePromise = (async () => {
      if (firebaseReady) return true;
      if (firebaseLoadAttempted) return firebaseReady;
      firebaseLoadAttempted = true;

      try {
        if (!window.firebase || !window.firebase.database || !window.firebase.auth) {
          await loadScript("https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js");
          await loadScript("https://www.gstatic.com/firebasejs/8.10.1/firebase-database.js");
          await loadScript("https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js");
        }
        await loadScript("firebase-config.js");
        await sleep(80);
        firebaseReady = Boolean(window.firebase && window.firebase.apps && window.firebase.apps.length > 0);
        if (firebaseReady) {
          initAuth();
        }
      } catch (err) {
        firebaseReady = false;
      }
      return firebaseReady;
    })();

    try {
      return await firebaseEnsurePromise;
    } finally {
      firebaseEnsurePromise = null;
    }
  }

  function emitAuthState() {
    const payload = currentUser
      ? {
          uid: currentUser.uid,
          displayName: currentUser.displayName || "Player",
          email: currentUser.email || "",
          photoURL: currentUser.photoURL || ""
        }
      : null;
    if (payload) {
      writeJSON(AUTH_CACHE_KEY, { user: payload, ts: Date.now() });
    } else {
      try {
        localStorage.removeItem(AUTH_CACHE_KEY);
      } catch (err) {
        // no-op
      }
    }
    authSubscribers.forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        // no-op
      }
    });
  }

  function initAuth() {
    if (authInitDone) return;
    if (!window.firebase || !window.firebase.auth) return;
    authInitDone = true;
    try {
      window.firebase.auth().onAuthStateChanged((user) => {
        authStateKnown = true;
        currentUser = user || null;
        emitAuthState();
      });
    } catch (err) {
      // no-op
    }
  }

  function getCurrentUser() {
    if (!currentUser) return null;
    return {
      uid: currentUser.uid,
      displayName: currentUser.displayName || "Player",
      email: currentUser.email || "",
      photoURL: currentUser.photoURL || ""
    };
  }

  function getUserAgent() {
    return (navigator.userAgent || "").toLowerCase();
  }

  function detectEmbeddedBrowser() {
    const ua = getUserAgent();
    const isKakao = ua.indexOf("kakaotalk") >= 0;
    const isLine = ua.indexOf(" line/") >= 0 || ua.indexOf("line/") >= 0;
    const isInstagram = ua.indexOf("instagram") >= 0;
    const isFacebook = ua.indexOf("fban") >= 0 || ua.indexOf("fbav") >= 0;
    const isNaverInApp = ua.indexOf("naver(inapp") >= 0;
    const isAndroidWebView = ua.indexOf("wv") >= 0 && ua.indexOf("android") >= 0;
    const isLikelyEmbedded = isKakao || isLine || isInstagram || isFacebook || isNaverInApp || isAndroidWebView;
    const label = isKakao
      ? "kakaotalk"
      : isLine
      ? "line"
      : isInstagram
      ? "instagram"
      : isFacebook
      ? "facebook"
      : isNaverInApp
      ? "naver-inapp"
      : isAndroidWebView
      ? "android-webview"
      : "";
    return { isLikelyEmbedded, label };
  }

  function canGoogleOAuthRunInCurrentBrowser() {
    const embedded = detectEmbeddedBrowser();
    return !embedded.isLikelyEmbedded;
  }

  function openInExternalBrowser(url) {
    const target = (url || window.location.href || "").toString();
    if (!target) return false;
    const ua = getUserAgent();
    const isAndroid = ua.indexOf("android") >= 0;
    const isIOS = /iphone|ipad|ipod/.test(ua);

    if (isAndroid && /^https?:\/\//i.test(target)) {
      try {
        const parsed = new URL(target);
        const scheme = (parsed.protocol || "https:").replace(":", "");
        const intentPath = parsed.host + parsed.pathname + parsed.search + parsed.hash;
        const intentUrl = "intent://" + intentPath + "#Intent;scheme=" + scheme + ";package=com.android.chrome;end";
        window.location.href = intentUrl;
        setTimeout(() => {
          window.location.href = parsed.href;
        }, 700);
        return true;
      } catch (err) {
        // fallback below
      }
    }

    if (isIOS) {
      try {
        window.open(target, "_blank", "noopener,noreferrer");
      } catch (err) {
        // no-op
      }
      window.location.href = target;
      return true;
    }

    try {
      window.open(target, "_blank", "noopener,noreferrer");
    } catch (err) {
      // no-op
    }
    window.location.href = target;
    return true;
  }

  function isEmbeddedGooglePolicyError(err) {
    const code = (err && err.code ? String(err.code) : "").toLowerCase();
    const message = (err && err.message ? String(err.message) : "").toLowerCase();
    if (code === "auth-embedded-browser-blocked") return true;
    if (message.indexOf("disallowed_useragent") >= 0) return true;
    if (message.indexOf("secure browser") >= 0) return true;
    if (message.indexOf("embedded") >= 0 && message.indexOf("browser") >= 0) return true;
    return false;
  }

  async function signInWithGoogle() {
    await ensureFirebase();
    if (!window.firebase || !window.firebase.auth) throw new Error("Firebase Auth unavailable");
    if (!canGoogleOAuthRunInCurrentBrowser()) {
      const embedded = detectEmbeddedBrowser();
      openInExternalBrowser(window.location.href);
      const err = new Error("AUTH_EMBEDDED_BROWSER_BLOCKED");
      err.code = "auth-embedded-browser-blocked";
      err.browser = embedded.label || "embedded-browser";
      throw err;
    }
    if (window.location.protocol === "file:") {
      const err = new Error("AUTH_UNSUPPORTED_CONTEXT");
      err.code = "auth-unsupported-context";
      throw err;
    }
    const isLocalHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
    if (window.location.protocol === "http:" && !isLocalHost) {
      const err = new Error("AUTH_INSECURE_CONTEXT");
      err.code = "auth-insecure-context";
      throw err;
    }
    const provider = new window.firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const auth = window.firebase.auth();

    // Best-effort persistence fallback chain for strict browser storage settings.
    try {
      await auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL);
    } catch (e1) {
      try {
        await auth.setPersistence(window.firebase.auth.Auth.Persistence.SESSION);
      } catch (e2) {
        try {
          await auth.setPersistence(window.firebase.auth.Auth.Persistence.NONE);
        } catch (e3) {
          const err = new Error("AUTH_STORAGE_UNAVAILABLE");
          err.code = "auth-storage-unavailable";
          throw err;
        }
      }
    }

    try {
      await auth.signInWithPopup(provider);
      return getCurrentUser();
    } catch (err) {
      if (isEmbeddedGooglePolicyError(err)) {
        openInExternalBrowser(window.location.href);
        const blockedErr = new Error("AUTH_EMBEDDED_BROWSER_BLOCKED");
        blockedErr.code = "auth-embedded-browser-blocked";
        throw blockedErr;
      }
      if (err && (err.code === "auth/popup-blocked" || err.code === "auth/cancelled-popup-request")) {
        try {
          await auth.signInWithRedirect(provider);
          return getCurrentUser();
        } catch (redirectErr) {
          throw redirectErr;
        }
      }
      throw err;
    }
  }

  async function signOutUser() {
    await ensureFirebase();
    if (!window.firebase || !window.firebase.auth) return;
    await window.firebase.auth().signOut();
  }

  function onAuthChange(callback) {
    if (typeof callback !== "function") return () => {};
    authSubscribers.push(callback);
    const cachedAuth = readJSON(AUTH_CACHE_KEY, null);
    if (cachedAuth && cachedAuth.user) {
      try {
        callback(cachedAuth.user);
      } catch (err) {
        // no-op
      }
    }
    ensureFirebase()
      .then((ready) => {
        if (!ready) {
          if (authSubscribers.includes(callback)) callback(null);
          return;
        }
        initAuth();
        if (authStateKnown && authSubscribers.includes(callback)) {
          callback(getCurrentUser());
        }
      })
      .catch(() => {
        if (authSubscribers.includes(callback)) callback(null);
      });

    return () => {
      const idx = authSubscribers.indexOf(callback);
      if (idx >= 0) authSubscribers.splice(idx, 1);
    };
  }

  function shouldShowGlobalTopRightBar() {
    try {
      const path = String(window.location.pathname || "").toLowerCase();
      if (!path || path === "/") return false;
      if (path.endsWith("/index.html")) return false;
      if (path.endsWith("/hall-of-fame.html")) return false;
      return true;
    } catch (err) {
      return false;
    }
  }

  function injectGlobalTopRightBar() {
    if (!shouldShowGlobalTopRightBar()) return;
    if (document.getElementById("global-top-right-bar")) return;

    try {
      document.querySelectorAll(".home-btn").forEach((el) => {
        el.style.display = "none";
      });
    } catch (err) {
      // no-op
    }

    const bar = document.createElement("div");
    bar.id = "global-top-right-bar";
    bar.style.position = "fixed";
    bar.style.top = "10px";
    bar.style.right = "10px";
    bar.style.zIndex = "2147483000";
    bar.style.display = "flex";
    bar.style.alignItems = "center";
    bar.style.gap = "8px";
    bar.style.padding = "6px 8px";
    bar.style.borderRadius = "12px";
    bar.style.background = "rgba(10, 14, 28, 0.72)";
    bar.style.backdropFilter = "blur(8px)";
    bar.style.border = "1px solid rgba(255, 255, 255, 0.18)";

    const userName = document.createElement("span");
    userName.style.fontSize = "12px";
    userName.style.color = "#e5e7eb";
    userName.style.maxWidth = "140px";
    userName.style.overflow = "hidden";
    userName.style.textOverflow = "ellipsis";
    userName.style.whiteSpace = "nowrap";
    userName.style.display = "none";

    const authBtn = document.createElement("button");
    authBtn.type = "button";
    authBtn.textContent = "Google 로그인";
    authBtn.style.border = "1px solid rgba(255,255,255,0.25)";
    authBtn.style.background = "rgba(255,255,255,0.10)";
    authBtn.style.color = "#fff";
    authBtn.style.padding = "8px 10px";
    authBtn.style.borderRadius = "10px";
    authBtn.style.fontSize = "12px";
    authBtn.style.fontWeight = "700";
    authBtn.style.cursor = "pointer";

    const homeBtn = document.createElement("button");
    homeBtn.type = "button";
    homeBtn.textContent = "홈";
    homeBtn.style.border = "1px solid rgba(255,255,255,0.25)";
    homeBtn.style.background = "rgba(255,255,255,0.10)";
    homeBtn.style.color = "#fff";
    homeBtn.style.padding = "8px 10px";
    homeBtn.style.borderRadius = "10px";
    homeBtn.style.fontSize = "12px";
    homeBtn.style.fontWeight = "700";
    homeBtn.style.cursor = "pointer";
    homeBtn.addEventListener("click", () => {
      window.location.href = "index.html";
    });

    async function renderAuthBar(user) {
      const signedIn = Boolean(user && user.uid);
      if (signedIn) {
        let name = String(user.displayName || user.email || "Google 사용자");
        try {
          name = await getPreferredDisplayName(user);
        } catch (err) {
          // no-op
        }
        userName.textContent = name;
        userName.style.display = "inline";
        authBtn.textContent = "로그아웃";
      } else {
        userName.textContent = "";
        userName.style.display = "none";
        authBtn.textContent = "Google 로그인";
      }
      authBtn.disabled = false;
      authBtn.style.opacity = "1";
      authBtn.style.cursor = "pointer";
    }

    authBtn.addEventListener("click", async () => {
      authBtn.disabled = true;
      authBtn.style.opacity = "0.6";
      authBtn.style.cursor = "default";
      try {
        if (getCurrentUser()) await signOutUser();
        else await signInWithGoogle();
      } catch (err) {
        authBtn.disabled = false;
        authBtn.style.opacity = "1";
        authBtn.style.cursor = "pointer";
      }
    });

    bar.appendChild(userName);
    bar.appendChild(authBtn);
    bar.appendChild(homeBtn);
    document.body.appendChild(bar);
    onAuthChange(renderAuthBar);
  }

  function hideRefreshButtonsGlobally() {
    try {
      document.querySelectorAll(".refresh-btn").forEach((btn) => {
        if (!btn) return;
        btn.style.display = "none";
      });
    } catch (err) {
      // no-op
    }
  }

  function normalizeScore(score) {
    const n = Number(score);
    if (Number.isNaN(n) || !Number.isFinite(n)) return null;
    return Math.round(n * 100) / 100;
  }

  function sanitizeName(name) {
    const base = (name || "").toString().trim().slice(0, 12);
    return base || "Player";
  }

  function normalizeNickname(name) {
    return (name || "").toString().trim().slice(0, 12);
  }

  function getLocalNicknameLimitStore() {
    const raw = readJSON(NICKNAME_LIMIT_LOCAL_KEY, {});
    return raw && typeof raw === "object" ? raw : {};
  }

  function setLocalNicknameLimitStore(store) {
    writeJSON(NICKNAME_LIMIT_LOCAL_KEY, store || {});
  }

  function checkNicknameLimitMeta(limitMeta, nowTs) {
    const now = Number(nowTs) || Date.now();
    const dayKey = toDayKey(now);
    const lastChangeAt = Number(limitMeta && limitMeta.lastChangeAt) || 0;
    const metaDayKey = String((limitMeta && limitMeta.dayKey) || "");
    const dayCountRaw = Number(limitMeta && limitMeta.dayCount) || 0;
    const dayCount = metaDayKey === dayKey ? dayCountRaw : 0;

    const elapsed = now - lastChangeAt;
    if (lastChangeAt > 0 && elapsed < NICKNAME_COOLDOWN_MS) {
      const err = new Error("NICKNAME_COOLDOWN");
      err.code = "nickname-cooldown";
      err.retryAfterSec = Math.ceil((NICKNAME_COOLDOWN_MS - elapsed) / 1000);
      throw err;
    }
    if (dayCount >= NICKNAME_DAILY_LIMIT) {
      const err = new Error("NICKNAME_DAILY_LIMIT");
      err.code = "nickname-daily-limit";
      err.limit = NICKNAME_DAILY_LIMIT;
      throw err;
    }

    return {
      dayKey,
      dayCount,
      next: {
        dayKey,
        dayCount: dayCount + 1,
        lastChangeAt: now
      }
    };
  }

  async function getServerNicknameByUid(uid) {
    const id = (uid || "").toString().trim();
    if (!id) return "";
    if (userNicknameCache[id]) return userNicknameCache[id];
    const useFirebase = await ensureFirebase();
    if (!useFirebase) return "";
    try {
      const snap = await window.firebase.database().ref(USER_PROFILE_ROOT + "/" + id + "/nickname").once("value");
      const raw = normalizeNickname(snap.val());
      if (!raw) return "";
      userNicknameCache[id] = sanitizeName(raw);
      return userNicknameCache[id];
    } catch (err) {
      return "";
    }
  }

  async function getPreferredDisplayName(userLike) {
    const user = userLike && userLike.uid ? userLike : getCurrentUser();
    if (!user || !user.uid) return "Player";
    const serverNick = await getServerNicknameByUid(user.uid);
    if (serverNick) return sanitizeName(serverNick);
    return sanitizeName(user.displayName || user.email || "Google 사용자");
  }

  async function setServerNickname(name) {
    const user = getCurrentUser();
    if (!user || !user.uid) {
      const err = new Error("AUTH_REQUIRED");
      err.code = "auth-required";
      throw err;
    }
    const normalized = normalizeNickname(name);
    if (!normalized) {
      const err = new Error("INVALID_NAME");
      err.code = "invalid-name";
      throw err;
    }

    const useFirebase = await ensureFirebase();
    if (!useFirebase) {
      const err = new Error("FIREBASE_UNAVAILABLE");
      err.code = "firebase-unavailable";
      throw err;
    }

    const safeName = sanitizeName(normalized);
    try {
      const currentName = await getPreferredDisplayName(user);
      if (sanitizeName(currentName) === safeName) return safeName;
    } catch (err) {
      // no-op
    }
    const now = Date.now();
    const profileRef = window.firebase.database().ref(USER_PROFILE_ROOT + "/" + user.uid);
    let serverLimitNext = null;
    try {
      const limitSnap = await profileRef.child("nicknameLimit").once("value");
      const checked = checkNicknameLimitMeta(limitSnap.val(), now);
      serverLimitNext = checked.next;
    } catch (err) {
      if (
        err &&
        (err.code === "nickname-cooldown" || err.code === "nickname-daily-limit")
      ) {
        throw err;
      }
      // Permission/network errors are handled by fallback path below.
    }

    let wroteServerProfile = false;
    try {
      const profileUpdate = {
        nickname: safeName,
        updatedAt: Date.now(),
        email: user.email || ""
      };
      if (serverLimitNext) profileUpdate.nicknameLimit = serverLimitNext;
      await profileRef.update(profileUpdate);
      userNicknameCache[user.uid] = safeName;
      wroteServerProfile = true;
    } catch (err) {
      // Fallback: if DB rules block profile path, enforce limits locally and keep nickname via Auth displayName.
      try {
        const localStore = getLocalNicknameLimitStore();
        const localMeta = localStore[user.uid] || {};
        const localChecked = checkNicknameLimitMeta(localMeta, now);
        const authUser = window.firebase && window.firebase.auth ? window.firebase.auth().currentUser : null;
        if (authUser && typeof authUser.updateProfile === "function") {
          await authUser.updateProfile({ displayName: safeName });
        }
        localStore[user.uid] = localChecked.next;
        setLocalNicknameLimitStore(localStore);
      } catch (authErr) {
        if (
          authErr &&
          (authErr.code === "nickname-cooldown" || authErr.code === "nickname-daily-limit")
        ) {
          throw authErr;
        }
        const e = new Error("NICKNAME_SAVE_FAILED");
        e.code = (err && err.code) || (authErr && authErr.code) || "nickname-save-failed";
        throw e;
      }
    }

    for (const gameId of Object.keys(GAME_META)) {
      try {
        const snap = await window.firebase
          .database()
          .ref("leaderboards/" + gameId)
          .orderByChild("uid")
          .equalTo(user.uid)
          .once("value");
        const updates = {};
        snap.forEach((child) => {
          updates[child.key + "/name"] = safeName;
        });
        if (Object.keys(updates).length > 0) {
          await window.firebase.database().ref("leaderboards/" + gameId).update(updates);
        }
      } catch (err) {
        // no-op
      }
      if (wroteServerProfile) {
        try {
          await refreshTop3CacheForGame(gameId);
        } catch (err) {
          // no-op
        }
      }
    }

    return safeName;
  }

  function getLocalStore() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}");
      return typeof parsed === "object" && parsed ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function setLocalStore(store) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(store));
  }

  function sortEntries(entries) {
    return entries
      .filter((e) => e && typeof e.score === "number")
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (a.ts || 0) - (b.ts || 0);
      });
  }

  async function pruneLocalGame(gameId, limit) {
    const keep = Math.max(1, Number(limit) || 3);
    const store = getLocalStore();
    const arr = Array.isArray(store[gameId]) ? store[gameId] : [];
    const sorted = sortEntries(arr);
    store[gameId] = sorted.slice(0, keep);
    setLocalStore(store);
    return store[gameId];
  }

  async function pruneFirebaseGame(gameId, limit) {
    const keep = Math.max(1, Number(limit) || 3);
    const snap = await window.firebase.database().ref("leaderboards/" + gameId).once("value");
    const all = [];
    snap.forEach((child) => {
      const v = child.val() || {};
      const score = normalizeScore(v.score);
      if (score === null) return;
      all.push({
        id: child.key,
        name: sanitizeName(v.name),
        score: score,
        ts: Number(v.ts) || 0
      });
    });

    const sorted = sortEntries(all);
    const removeTargets = sorted.slice(keep);
    await Promise.all(
      removeTargets.map((row) => window.firebase.database().ref("leaderboards/" + gameId + "/" + row.id).remove())
    );
    return sorted.slice(0, keep);
  }

  async function pruneGameRankings(gameId, limit) {
    const keep = Math.max(1, Number(limit) || 3);
    const useFirebase = await ensureFirebase();

    if (useFirebase) {
      try {
        return await pruneFirebaseGame(gameId, keep);
      } catch (err) {
        return await pruneLocalGame(gameId, keep);
      }
    }
    return await pruneLocalGame(gameId, keep);
  }

  async function waitForAuthState(timeoutMs) {
    const timeout = Math.max(0, Number(timeoutMs) || 1200);
    const started = Date.now();
    while (!authStateKnown && Date.now() - started < timeout) {
      await sleep(60);
    }
    return authStateKnown;
  }

  function getPersistedTopScoreCache() {
    const cache = readJSON(TOP_SCORES_PERSIST_KEY, {});
    return cache && typeof cache === "object" ? cache : {};
  }

  function setPersistedTopScoreCache(cache) {
    writeJSON(TOP_SCORES_PERSIST_KEY, cache || {});
  }

  function getPersistedTopScores(gameId, limit) {
    const cache = getPersistedTopScoreCache();
    const entry = cache[gameId];
    if (!entry || !Array.isArray(entry.rows)) return null;
    return sortEntries(entry.rows).slice(0, Math.max(1, Number(limit) || 3));
  }

  function setPersistedTopScores(gameId, rows) {
    const cache = getPersistedTopScoreCache();
    cache[gameId] = {
      ts: Date.now(),
      rows: sortEntries(Array.isArray(rows) ? rows : []).slice(0, 3)
    };
    setPersistedTopScoreCache(cache);
  }

  function clearPersistedTopScores(gameId) {
    const cache = getPersistedTopScoreCache();
    if (gameId) {
      delete cache[gameId];
    } else {
      Object.keys(cache).forEach((k) => delete cache[k]);
    }
    setPersistedTopScoreCache(cache);
  }

  function parseTop3CacheNode(node) {
    if (!node) return [];
    const rows = Array.isArray(node) ? node : Array.isArray(node.rows) ? node.rows : [];
    const parsed = [];
    rows.forEach((row, idx) => {
      const score = normalizeScore(row && row.score);
      if (score === null) return;
      parsed.push({
        id: row.id || "cache_" + idx,
        name: sanitizeName(row.name),
        score: score,
        ts: Number(row.ts) || 0,
        source: "firebase-cache"
      });
    });
    return sortEntries(parsed).slice(0, 3);
  }

  async function readTop3CacheBundle(gameIds) {
    const map = {};
    const useFirebase = await ensureFirebase();
    if (!useFirebase) return map;
    try {
      const snap = await window.firebase.database().ref(TOP3_CACHE_ROOT).once("value");
      const raw = snap.val() || {};
      gameIds.forEach((gameId) => {
        const rows = parseTop3CacheNode(raw[gameId]);
        if (rows.length) {
          map[gameId] = rows;
          setPersistedTopScores(gameId, rows);
        }
      });
    } catch (err) {
      // no-op
    }
    return map;
  }

  async function getTopScores(gameId, limit, options) {
    const scoreLimit = Math.max(1, Number(limit) || 3);
    const opts = options || {};
    const forceRefresh = Boolean(opts.forceRefresh);

    if (!forceRefresh && scoreLimit <= 3) {
      const persisted = getPersistedTopScores(gameId, scoreLimit);
      if (persisted && persisted.length) return persisted;
    }

    const useFirebase = await ensureFirebase();

    if (useFirebase) {
      try {
        const snap = await window.firebase
          .database()
          .ref("leaderboards/" + gameId)
          .orderByChild("score")
          .limitToLast(scoreLimit)
          .once("value");

        const arr = [];
        snap.forEach((child) => {
          const value = child.val() || {};
          const score = normalizeScore(value.score);
          if (score === null) return;
          arr.push({
            id: child.key,
            name: sanitizeName(value.name),
            score: score,
            ts: Number(value.ts) || 0,
            source: "firebase"
          });
        });

        const rows = sortEntries(arr).slice(0, scoreLimit);
        if (scoreLimit <= 3 && rows.length) setPersistedTopScores(gameId, rows);
        return rows;
      } catch (err) {
        // fallback to local
      }
    }

    const store = getLocalStore();
    const arr = Array.isArray(store[gameId]) ? store[gameId] : [];
    const rows = sortEntries(arr).slice(0, scoreLimit);
    if (scoreLimit <= 3 && rows.length) setPersistedTopScores(gameId, rows);
    return rows;
  }

  async function getTopScoresBundle(gameIds, limit, options) {
    const ids = Array.isArray(gameIds) ? gameIds.filter(Boolean) : [];
    const scoreLimit = Math.max(1, Number(limit) || 3);
    const opts = options || {};
    const forceRefresh = Boolean(opts.forceRefresh);
    const result = {};
    const missing = [];
    let mode = "none";

    ids.forEach((gameId) => {
      if (!forceRefresh && scoreLimit <= 3) {
        const persisted = getPersistedTopScores(gameId, scoreLimit);
        if (persisted && persisted.length) {
          result[gameId] = persisted;
          mode = "local-cache";
          return;
        }
      }
      missing.push(gameId);
    });

    if (missing.length && scoreLimit <= 3) {
      const bundle = await readTop3CacheBundle(missing);
      missing.slice().forEach((gameId) => {
        if (bundle[gameId] && bundle[gameId].length) {
          result[gameId] = bundle[gameId].slice(0, scoreLimit);
        }
      });
      if (Object.keys(bundle).length) {
        mode = mode === "local-cache" ? "bundle(top3-cache + local-cache)" : "bundle(top3-cache)";
      }
    }

    const stillMissing = ids.filter((gameId) => !Array.isArray(result[gameId]));
    if (stillMissing.length) {
      await Promise.all(
        stillMissing.map(async (gameId) => {
          result[gameId] = await getTopScores(gameId, scoreLimit, { forceRefresh: true });
        })
      );
      if (mode.indexOf("bundle") >= 0) mode = "bundle(top3-cache + fallback)";
      else mode = "bundle";
    }

    result.__mode = mode;
    return result;
  }

  function setTop3LoadingRows(listEl, loadingText) {
    if (!listEl) return;
    listEl.innerHTML = "";
    for (let i = 0; i < 3; i++) {
      const li = document.createElement("li");
      const left = document.createElement("span");
      const rank = document.createElement("strong");
      const right = document.createElement("span");
      li.style.display = "flex";
      li.style.justifyContent = "space-between";
      li.style.alignItems = "center";
      li.style.gap = "10px";
      li.style.padding = "4px 0";
      rank.textContent = String(i + 1) + ".";
      left.appendChild(rank);
      left.appendChild(document.createTextNode(" " + String(loadingText || "Loading...")));
      right.textContent = "-";
      right.style.opacity = "0.95";
      li.appendChild(left);
      li.appendChild(right);
      listEl.appendChild(li);
    }
  }

  function fillTop3Rows(listEl, rows, options) {
    if (!listEl) return;
    const opts = options || {};
    const scorePrefix = String(opts.scorePrefix || "");
    const scoreSuffix = String(opts.scoreSuffix || "");
    const emptyText = String(opts.emptyText || "No record");
    const rankLabel = typeof opts.rankLabel === "function" ? opts.rankLabel : null;

    listEl.innerHTML = "";
    for (let i = 0; i < 3; i++) {
      const li = document.createElement("li");
      const left = document.createElement("span");
      const rank = document.createElement("strong");
      const right = document.createElement("span");
      const row = rows[i];
      li.style.display = "flex";
      li.style.justifyContent = "space-between";
      li.style.alignItems = "center";
      li.style.gap = "10px";
      li.style.padding = "4px 0";
      rank.textContent = rankLabel ? String(rankLabel(i + 1)) : String(i + 1) + ".";
      left.appendChild(rank);
      left.appendChild(document.createTextNode(" "));
      if (row) {
        left.appendChild(document.createTextNode(sanitizeName(row.name)));
        right.textContent = scorePrefix + String(row.score) + scoreSuffix;
      } else {
        left.appendChild(document.createTextNode(emptyText));
        right.textContent = "-";
      }
      right.style.opacity = "0.95";
      li.appendChild(left);
      li.appendChild(right);
      listEl.appendChild(li);
    }
  }

  async function renderTop3List(listEl, gameId, options) {
    const opts = options || {};
    setTop3LoadingRows(listEl, opts.loadingText);

    let rows = [];
    try {
      rows = await getTopScores(gameId, 3, { forceRefresh: Boolean(opts.forceRefresh) });
    } catch (err) {
      rows = [];
    }
    fillTop3Rows(listEl, rows, opts);
    return rows;
  }

  function ensureGameOverTop3Panel(containerEl, options) {
    if (!containerEl) return null;
    const opts = options || {};
    const panelId = String(opts.panelId || "lb-top3-panel");
    let panel = containerEl.querySelector("#" + panelId);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = panelId;
      panel.style.margin = "12px 0";
      panel.style.marginLeft = "auto";
      panel.style.marginRight = "auto";
      panel.style.padding = "10px";
      panel.style.borderRadius = "10px";
      panel.style.background = "rgba(15, 23, 42, 0.94)";
      panel.style.border = "1px solid rgba(255,255,255,0.35)";
      panel.style.boxShadow = "0 8px 20px rgba(0,0,0,0.45)";
      panel.style.color = "#ffffff";
      panel.style.width = "min(320px, 90%)";
      panel.style.position = "relative";
      panel.style.zIndex = "999";
      panel.style.alignSelf = "center";

      const title = document.createElement("h3");
      title.textContent = String(opts.title || "TOP 3");
      title.style.margin = "0 0 8px";
      title.style.fontSize = "1rem";
      title.style.color = "#ffffff";
      title.style.textAlign = "center";
      panel.appendChild(title);

      const list = document.createElement("ol");
      list.style.margin = "0";
      list.style.padding = "0 0 0 18px";
      list.style.color = "#ffffff";
      panel.appendChild(list);

      const anchor = containerEl.querySelector(".start-btn, #restart-btn, button");
      if (anchor && anchor.parentNode === containerEl) {
        containerEl.insertBefore(panel, anchor);
      } else {
        containerEl.appendChild(panel);
      }
    }
    return panel.querySelector("ol");
  }

  function ensureGameOverActions(containerEl, options) {
    if (!containerEl) return null;
    const opts = options || {};
    const panelId = String(opts.panelId || "lb-top3-panel");
    const actionsId = String(opts.actionsId || panelId + "-actions");
    let row = containerEl.querySelector("#" + actionsId);
    if (!row) {
      row = document.createElement("div");
      row.id = actionsId;
      row.style.display = "flex";
      row.style.justifyContent = "center";
      row.style.alignItems = "center";
      row.style.gap = "10px";
      row.style.marginTop = "10px";
      row.style.width = "100%";
      row.style.position = "relative";
      row.style.zIndex = "999";

      const restartBtn = document.createElement("button");
      restartBtn.type = "button";
      restartBtn.dataset.lbAction = "restart";
      restartBtn.style.padding = "10px 16px";
      restartBtn.style.border = "1px solid rgba(255,255,255,0.35)";
      restartBtn.style.borderRadius = "10px";
      restartBtn.style.background = "rgba(255,255,255,0.16)";
      restartBtn.style.color = "#ffffff";
      restartBtn.style.cursor = "pointer";
      restartBtn.style.fontWeight = "700";
      restartBtn.style.minWidth = "104px";
      row.appendChild(restartBtn);

      const homeBtn = document.createElement("button");
      homeBtn.type = "button";
      homeBtn.dataset.lbAction = "home";
      homeBtn.style.padding = "10px 16px";
      homeBtn.style.border = "1px solid rgba(255,255,255,0.35)";
      homeBtn.style.borderRadius = "10px";
      homeBtn.style.background = "rgba(255,255,255,0.16)";
      homeBtn.style.color = "#ffffff";
      homeBtn.style.cursor = "pointer";
      homeBtn.style.fontWeight = "700";
      homeBtn.style.minWidth = "104px";
      row.appendChild(homeBtn);

      const panel = containerEl.querySelector("#" + panelId);
      if (panel && panel.parentNode === containerEl) {
        if (panel.nextSibling) containerEl.insertBefore(row, panel.nextSibling);
        else containerEl.appendChild(row);
      } else {
        containerEl.appendChild(row);
      }
    }

    const restartBtn = row.querySelector('[data-lb-action="restart"]');
    const homeBtn = row.querySelector('[data-lb-action="home"]');
    if (restartBtn) {
      restartBtn.textContent = String(opts.restartText || "다시시작");
      restartBtn.onclick = typeof opts.onRestart === "function" ? opts.onRestart : null;
    }
    if (homeBtn) {
      homeBtn.textContent = String(opts.homeText || "홈");
      const homeHref = String(opts.homeHref || "index.html");
      homeBtn.onclick = () => {
        window.location.href = homeHref;
      };
    }
    return row;
  }

  async function renderGameOverTop3Panel(containerEl, gameId, options) {
    const opts = options || {};
    const listEl = ensureGameOverTop3Panel(containerEl, opts);
    if (!listEl) return [];
    const hideSelector = String(opts.hideNativeActionSelector || ".start-btn, #restart-btn");
    if (hideSelector && containerEl && typeof containerEl.querySelectorAll === "function") {
      containerEl.querySelectorAll(hideSelector).forEach((el) => {
        if (el && el.dataset && el.dataset.lbAction) return;
        if (el) el.style.display = "none";
      });
    }
    ensureGameOverActions(containerEl, opts);
    return await renderTop3List(listEl, gameId, opts);
  }

  async function refreshTop3CacheForGame(gameId) {
    const useFirebase = await ensureFirebase();
    if (!useFirebase) return;
    try {
      const rows = await getTopScores(gameId, 3, { forceRefresh: true });
      setPersistedTopScores(gameId, rows);
      await window.firebase.database().ref(TOP3_CACHE_ROOT + "/" + gameId).set({
        updatedAt: Date.now(),
        rows: rows.map((row) => ({
          name: sanitizeName(row.name),
          score: Number(row.score) || 0,
          ts: Number(row.ts) || Date.now()
        }))
      });
    } catch (err) {
      // no-op
    }
  }

  async function saveScore(gameId, name, score, extra) {
    const normalized = normalizeScore(score);
    if (normalized === null) throw new Error("Invalid score");

    const user = getCurrentUser();
    let preferredName = sanitizeName(name);
    if (user && user.uid) {
      preferredName = await getPreferredDisplayName(user);
    }
    const payload = {
      name: sanitizeName(preferredName),
      score: normalized,
      ts: Date.now(),
      gameId: gameId
    };
    if (user) {
      payload.uid = user.uid;
      payload.photoURL = user.photoURL || "";
      payload.provider = "google";
    }

    if (extra && typeof extra === "object") {
      Object.keys(extra).forEach((k) => {
        payload[k] = extra[k];
      });
    }

    localStorage.setItem(NAME_KEY, payload.name);

    const useFirebase = await ensureFirebase();
    if (REQUIRE_AUTH_FOR_WRITE && useFirebase && !user) {
      const err = new Error("AUTH_REQUIRED");
      err.code = "auth-required";
      throw err;
    }

    if (useFirebase) {
      try {
        await window.firebase.database().ref("leaderboards/" + gameId).push(payload);
        await pruneGameRankings(gameId, 3);
        await refreshTop3CacheForGame(gameId);
        return Object.assign({ source: "firebase" }, payload);
      } catch (err) {
        // If Firebase is available, keep write policy strict and do not fallback to local.
        throw err;
      }
    }

    if (REQUIRE_AUTH_FOR_WRITE) {
      const err = new Error("FIREBASE_UNAVAILABLE");
      err.code = "firebase-unavailable";
      throw err;
    }

    const store = getLocalStore();
    const current = Array.isArray(store[gameId]) ? store[gameId] : [];
    current.push(payload);
    store[gameId] = sortEntries(current).slice(0, 3);
    setLocalStore(store);
    setPersistedTopScores(gameId, store[gameId]);
    return Object.assign({ source: "local" }, payload);
  }

  function playFanfare() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const notes = [523.25, 659.25, 783.99, 1046.5];
      let t = ctx.currentTime;

      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = idx % 2 ? "triangle" : "sawtooth";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.3);
        t += 0.12;
      });

      setTimeout(() => ctx.close().catch(() => {}), 1200);
    } catch (err) {
      // no-op
    }
  }

  function makeConfetti(container) {
    const colors = ["#f59e0b", "#ef4444", "#22c55e", "#3b82f6", "#a855f7", "#f97316"];
    for (let i = 0; i < 80; i++) {
      const bit = document.createElement("span");
      bit.style.position = "absolute";
      bit.style.top = "-12px";
      bit.style.left = Math.random() * 100 + "%";
      bit.style.width = 6 + Math.random() * 6 + "px";
      bit.style.height = 6 + Math.random() * 10 + "px";
      bit.style.background = colors[Math.floor(Math.random() * colors.length)];
      bit.style.opacity = "0.9";
      bit.style.borderRadius = "2px";
      bit.style.transform = "rotate(" + Math.random() * 360 + "deg)";
      bit.style.transition =
        "transform " +
        (1.4 + Math.random() * 1.8) +
        "s linear, top " +
        (1.4 + Math.random() * 1.8) +
        "s ease-in";
      container.appendChild(bit);
      requestAnimationFrame(() => {
        bit.style.top = "110%";
        bit.style.transform = "translateX(" + (Math.random() - 0.5) * 240 + "px) rotate(" + Math.random() * 720 + "deg)";
      });
      setTimeout(() => bit.remove(), 3400);
    }
  }

  async function openCelebrationDialog(gameId, score) {
    return new Promise((resolve) => {
      const wrap = document.createElement("div");
      wrap.style.position = "fixed";
      wrap.style.inset = "0";
      wrap.style.background = "rgba(5,10,25,0.82)";
      wrap.style.zIndex = "99999";
      wrap.style.display = "flex";
      wrap.style.alignItems = "center";
      wrap.style.justifyContent = "center";
      wrap.style.padding = "20px";

      const box = document.createElement("div");
      box.style.width = "min(92vw, 460px)";
      box.style.background = "linear-gradient(135deg,#111827,#1f2937)";
      box.style.border = "1px solid rgba(245,158,11,0.5)";
      box.style.borderRadius = "16px";
      box.style.padding = "24px";
      box.style.color = "#f9fafb";
      box.style.textAlign = "center";
      box.style.position = "relative";
      box.style.boxShadow = "0 20px 40px rgba(0,0,0,0.45)";

      const title = document.createElement("h2");
      title.textContent = "축하합니다! 순위권에 진입했습니다!";
      title.style.margin = "0 0 12px";
      title.style.color = "#fbbf24";
      title.style.fontSize = "1.35rem";

      const info = document.createElement("p");
      const unit = GAME_META[gameId] && GAME_META[gameId].unit ? " " + GAME_META[gameId].unit : "";
      info.textContent = (GAME_META[gameId] ? GAME_META[gameId].name : gameId) + " TOP 3 진입 점수: " + score + unit;
      info.style.margin = "0 0 16px";
      info.style.opacity = "0.92";

      const identity = document.createElement("p");
      identity.style.margin = "10px 0 0";
      identity.style.fontSize = "0.9rem";
      identity.style.opacity = "0.85";

      const btnWrap = document.createElement("div");
      btnWrap.style.display = "flex";
      btnWrap.style.gap = "10px";
      btnWrap.style.marginTop = "14px";

      const skipBtn = document.createElement("button");
      skipBtn.textContent = "닫기";
      skipBtn.style.flex = "1";
      skipBtn.style.padding = "12px";
      skipBtn.style.border = "1px solid rgba(255,255,255,0.25)";
      skipBtn.style.borderRadius = "10px";
      skipBtn.style.background = "transparent";
      skipBtn.style.color = "#fff";
      skipBtn.style.cursor = "pointer";
      btnWrap.appendChild(skipBtn);
      box.appendChild(title);
      box.appendChild(info);
      box.appendChild(identity);
      box.appendChild(btnWrap);
      wrap.appendChild(box);
      document.body.appendChild(wrap);

      makeConfetti(wrap);
      playFanfare();

      const close = (saved) => {
        wrap.remove();
        resolve(saved);
      };

      skipBtn.addEventListener("click", () => close(false));
      wrap.addEventListener("click", (e) => {
        if (e.target === wrap) close(false);
      });

      (async () => {
        const user = getCurrentUser();
        if (user) {
          identity.textContent = `자동 등록 중... (${user.displayName || "Google 사용자"})`;
        } else {
          identity.textContent = "로그인 정보 확인 중...";
        }

        try {
          await saveScore(gameId, "", score);
          const savedUser = getCurrentUser();
          const savedName = (savedUser && savedUser.displayName) || "Google 사용자";
          identity.textContent = `자동 등록 완료: ${savedName}`;
        } catch (err) {
          if (err && err.code === "auth-required") {
            identity.textContent = "Google 로그인 사용자만 자동 등록됩니다.";
          } else if (err && err.code === "firebase-unavailable") {
            identity.textContent = "서버 연결 문제로 자동 등록에 실패했습니다.";
          } else {
            identity.textContent = "자동 등록 중 오류가 발생했습니다.";
          }
        }
      })();
    });
  }

  async function checkAndCelebrate(gameId, score) {
    if (!GAME_META[gameId]) return false;
    const normalized = normalizeScore(score);
    if (normalized === null) return false;
    await ensureFirebase();
    await waitForAuthState(180);
    if (!getCurrentUser()) {
      console.log("[RANK] checkAndCelebrate skipped: not signed-in", { gameId: gameId, score: normalized });
      return false;
    }

    const lockKey = "hof_checked_" + gameId + "_" + normalized;
    if (sessionStorage.getItem(lockKey) === "1") return false;
    sessionStorage.setItem(lockKey, "1");

    const top3 = await getTopScores(gameId, 3);
    const threshold = top3.length >= 3 ? top3[top3.length - 1].score : null;
    const qualifies = top3.length < 3 || normalized > Number(threshold);
    console.log("[RANK] checkAndCelebrate", {
      gameId: gameId,
      score: normalized,
      threshold: threshold,
      qualifies: qualifies,
      top3Count: top3.length,
      user: getCurrentUser() ? "signed-in" : "signed-out"
    });
    if (!qualifies) return false;

    try {
      await openCelebrationDialog(gameId, normalized);
    } catch (err) {
      console.log("[RANK] celebration/save failed", {
        gameId: gameId,
        score: normalized,
        code: err && err.code ? err.code : "",
        message: err && err.message ? err.message : String(err)
      });
      throw err;
    }
    return true;
  }

  async function clearAllRankings() {
    const result = {
      firebaseCleared: false,
      localCleared: false,
      cookiesCleared: false
    };
    const useFirebase = await ensureFirebase();

    if (useFirebase) {
      try {
        await window.firebase.database().ref("leaderboards").remove();
        await window.firebase.database().ref(TOP3_CACHE_ROOT).remove();
        result.firebaseCleared = true;
      } catch (err) {
        result.firebaseCleared = false;
      }
    }

    localStorage.removeItem(LOCAL_KEY);
    localStorage.removeItem(NAME_KEY);
    try {
      Object.keys(localStorage)
        .filter((k) => k.indexOf("hof_") === 0)
        .forEach((k) => localStorage.removeItem(k));
    } catch (err) {
      // no-op
    }
    try {
      Object.keys(sessionStorage)
        .filter((k) => k.indexOf("hof_") === 0)
        .forEach((k) => sessionStorage.removeItem(k));
    } catch (err) {
      // no-op
    }
    result.localCleared = true;
    clearPersistedTopScores();

    // Best-effort cookie cleanup for current domain/path.
    // HttpOnly cookies cannot be cleared from JavaScript.
    try {
      const cookiePairs = document.cookie ? document.cookie.split(";") : [];
      const hostParts = window.location.hostname.split(".");
      const domains = [window.location.hostname];
      if (hostParts.length >= 2) {
        domains.push("." + hostParts.slice(-2).join("."));
      }
      const paths = ["/", window.location.pathname || "/"];

      cookiePairs.forEach((pair) => {
        const eq = pair.indexOf("=");
        const rawName = (eq > -1 ? pair.slice(0, eq) : pair).trim();
        if (!rawName) return;
        paths.forEach((p) => {
          document.cookie = `${rawName}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${p}`;
          domains.forEach((d) => {
            document.cookie = `${rawName}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${p}; domain=${d}`;
          });
        });
      });
      result.cookiesCleared = true;
    } catch (err) {
      result.cookiesCleared = false;
    }

    return result;
  }

  window.LeaderboardSystem = {
    GAME_META: GAME_META,
    ensureFirebase: ensureFirebase,
    getTopScores: getTopScores,
    getTopScoresBundle: getTopScoresBundle,
    getCurrentUser: getCurrentUser,
    getPreferredDisplayName: getPreferredDisplayName,
    setServerNickname: setServerNickname,
    signInWithGoogle: signInWithGoogle,
    signOutUser: signOutUser,
    onAuthChange: onAuthChange,
    pruneGameRankings: pruneGameRankings,
    saveScore: saveScore,
    checkAndCelebrate: checkAndCelebrate,
    renderTop3List: renderTop3List,
    renderGameOverTop3Panel: renderGameOverTop3Panel,
    clearAllRankings: clearAllRankings,
    openInExternalBrowser: openInExternalBrowser,
    canGoogleOAuthRunInCurrentBrowser: canGoogleOAuthRunInCurrentBrowser,
    detectEmbeddedBrowser: detectEmbeddedBrowser
  };

  injectGlobalTopRightBar();
  hideRefreshButtonsGlobally();
  syncGlobalVersionFromIndex();
})();
