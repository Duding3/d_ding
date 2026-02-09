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
  const REQUIRE_AUTH_FOR_WRITE = true;

  let firebaseReady = false;
  let firebaseLoadAttempted = false;
  let firebaseDisabledReason = "";
  let authInitDone = false;
  let currentUser = null;
  const authSubscribers = [];

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
    if (firebaseLoadAttempted) return false;
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

  async function signInWithGoogle() {
    await ensureFirebase();
    if (!window.firebase || !window.firebase.auth) throw new Error("Firebase Auth unavailable");
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
    callback(getCurrentUser());

    // Trigger Firebase/Auth initialization so initial login state is restored
    // even before any game-score API is called on the page.
    ensureFirebase()
      .then((ready) => {
        if (!ready) return;
        initAuth();
        if (authSubscribers.includes(callback)) {
          callback(getCurrentUser());
        }
      })
      .catch(() => {});

    return () => {
      const idx = authSubscribers.indexOf(callback);
      if (idx >= 0) authSubscribers.splice(idx, 1);
    };
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

  async function getTopScores(gameId, limit) {
    const scoreLimit = Math.max(1, Number(limit) || 3);
    await pruneGameRankings(gameId, scoreLimit);
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

        return sortEntries(arr).slice(0, scoreLimit);
      } catch (err) {
        // fallback to local
      }
    }

    const store = getLocalStore();
    const arr = Array.isArray(store[gameId]) ? store[gameId] : [];
    return sortEntries(arr).slice(0, scoreLimit);
  }

  async function saveScore(gameId, name, score, extra) {
    const normalized = normalizeScore(score);
    if (normalized === null) throw new Error("Invalid score");

    const user = getCurrentUser();
    const payload = {
      name: sanitizeName(user && user.displayName ? user.displayName : name),
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
      title.textContent = "축하합니다 순위권에 진입했습니다!";
      title.style.margin = "0 0 12px";
      title.style.color = "#fbbf24";
      title.style.fontSize = "1.35rem";

      const info = document.createElement("p");
      const unit = GAME_META[gameId] && GAME_META[gameId].unit ? " " + GAME_META[gameId].unit : "";
      info.textContent = (GAME_META[gameId] ? GAME_META[gameId].name : gameId) + " TOP 3 진입 점수: " + score + unit;
      info.style.margin = "0 0 16px";
      info.style.opacity = "0.92";

      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 12;
      input.placeholder = "이름 입력";
      input.value = (getCurrentUser() && getCurrentUser().displayName) || localStorage.getItem(NAME_KEY) || "";
      input.style.width = "100%";
      input.style.padding = "12px";
      input.style.borderRadius = "10px";
      input.style.border = "1px solid rgba(255,255,255,0.2)";
      input.style.background = "rgba(255,255,255,0.08)";
      input.style.color = "#fff";

      const identity = document.createElement("p");
      identity.style.margin = "10px 0 0";
      identity.style.fontSize = "0.9rem";
      identity.style.opacity = "0.85";

      const btnWrap = document.createElement("div");
      btnWrap.style.display = "flex";
      btnWrap.style.gap = "10px";
      btnWrap.style.marginTop = "14px";

      const saveBtn = document.createElement("button");
      saveBtn.textContent = "기록 저장";
      saveBtn.style.flex = "1";
      saveBtn.style.padding = "12px";
      saveBtn.style.border = "none";
      saveBtn.style.borderRadius = "10px";
      saveBtn.style.background = "#f59e0b";
      saveBtn.style.color = "#111827";
      saveBtn.style.fontWeight = "700";
      saveBtn.style.cursor = "pointer";

      const skipBtn = document.createElement("button");
      skipBtn.textContent = "닫기";
      skipBtn.style.flex = "1";
      skipBtn.style.padding = "12px";
      skipBtn.style.border = "1px solid rgba(255,255,255,0.25)";
      skipBtn.style.borderRadius = "10px";
      skipBtn.style.background = "transparent";
      skipBtn.style.color = "#fff";
      skipBtn.style.cursor = "pointer";

      const authBtn = document.createElement("button");
      authBtn.style.width = "100%";
      authBtn.style.marginTop = "10px";
      authBtn.style.padding = "10px";
      authBtn.style.border = "1px solid rgba(255,255,255,0.28)";
      authBtn.style.borderRadius = "10px";
      authBtn.style.background = "rgba(255,255,255,0.07)";
      authBtn.style.color = "#fff";
      authBtn.style.cursor = "pointer";

      btnWrap.appendChild(saveBtn);
      btnWrap.appendChild(skipBtn);
      box.appendChild(title);
      box.appendChild(info);
      box.appendChild(input);
      box.appendChild(identity);
      box.appendChild(authBtn);
      box.appendChild(btnWrap);
      wrap.appendChild(box);
      document.body.appendChild(wrap);

      makeConfetti(wrap);
      playFanfare();
      setTimeout(() => input.focus(), 80);

      const close = (saved) => {
        wrap.remove();
        resolve(saved);
      };

      const syncIdentityUi = () => {
        const user = getCurrentUser();
        if (user) {
          identity.textContent = `Google 로그인: ${user.displayName || "사용자"}`;
          authBtn.textContent = "Google 로그아웃";
          input.value = user.displayName || input.value;
          input.disabled = true;
          input.style.opacity = "0.7";
        } else {
          identity.textContent = "Google 로그인 시 계정 이름으로 저장됩니다.";
          authBtn.textContent = "Google 로그인";
          input.disabled = false;
          input.style.opacity = "1";
        }
      };
      syncIdentityUi();

      saveBtn.addEventListener("click", async () => {
        const name = sanitizeName(input.value);
        try {
          await saveScore(gameId, name, score);
          close(true);
        } catch (err) {
          if (err && err.code === "auth-required") {
            identity.textContent = "랭킹 저장은 Google 로그인 사용자만 가능합니다.";
            return;
          }
          if (err && err.code === "firebase-unavailable") {
            identity.textContent = "서버 연결 후 다시 시도해주세요. (현재 저장 불가)";
            return;
          }
          identity.textContent = "저장 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
        }
      });

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") saveBtn.click();
      });

      skipBtn.addEventListener("click", () => close(false));
      authBtn.addEventListener("click", async () => {
        authBtn.disabled = true;
        try {
          if (getCurrentUser()) await signOutUser();
          else await signInWithGoogle();
          syncIdentityUi();
        } catch (err) {
          identity.textContent = "Google 로그인 처리 중 오류가 발생했습니다.";
        } finally {
          authBtn.disabled = false;
        }
      });
      wrap.addEventListener("click", (e) => {
        if (e.target === wrap) close(false);
      });
    });
  }

  async function checkAndCelebrate(gameId, score) {
    const normalized = normalizeScore(score);
    if (normalized === null) return false;

    const lockKey = "hof_checked_" + gameId + "_" + normalized;
    if (sessionStorage.getItem(lockKey) === "1") return false;
    sessionStorage.setItem(lockKey, "1");

    const top3 = await getTopScores(gameId, 3);
    const threshold = top3.length >= 3 ? top3[top3.length - 1].score : null;
    const qualifies = top3.length < 3 || normalized > Number(threshold);
    if (!qualifies) return false;

    await openCelebrationDialog(gameId, normalized);
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
    getCurrentUser: getCurrentUser,
    signInWithGoogle: signInWithGoogle,
    signOutUser: signOutUser,
    onAuthChange: onAuthChange,
    pruneGameRankings: pruneGameRankings,
    saveScore: saveScore,
    checkAndCelebrate: checkAndCelebrate,
    clearAllRankings: clearAllRankings
  };
})();
