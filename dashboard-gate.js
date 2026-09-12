(() => {
  "use strict";

  const AUTO_LOCK_MS = 30 * 60 * 1000;
  const JSONP_TIMEOUT_MS = 25000;
  let encryptedToken = "";
  let credentials = null;
  let lockTimer = 0;
  const el = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    [
      "unlock-screen", "unlock-form", "encrypted-input", "unlock-password", "unlock-button",
      "unlock-status", "dashboard-shell", "lock-button", "show-password",
    ].forEach((id) => { el[toCamel(id)] = document.getElementById(id); });

    encryptedToken = tokenFromHash();
    if (encryptedToken) el.encryptedInput.value = encryptedToken;
    scrubHash();

    el.unlockForm.addEventListener("submit", unlock);
    el.lockButton.addEventListener("click", lockNow);
    el.showPassword.addEventListener("change", () => {
      el.unlockPassword.type = el.showPassword.checked ? "text" : "password";
    });
    ["pointerdown", "keydown"].forEach((name) => {
      document.addEventListener(name, () => {
        if (credentials) scheduleAutoLock();
      }, { passive: true });
    });
    window.addEventListener("pagehide", clearCredentials);

    if (!window.MurphyCredentialCrypto?.isSupported()) {
      setStatus("This browser cannot unlock the bundle. Use current Firefox, Chrome, or Edge over HTTPS or localhost.", true);
      el.unlockButton.disabled = true;
    }
  }

  async function unlock(event) {
    event.preventDefault();
    const token = el.encryptedInput.value.trim();
    const password = el.unlockPassword.value;
    if (!token) {
      setStatus("Paste the encrypted dashboard string first.", true);
      return;
    }
    if (!password) {
      setStatus("Enter the password.", true);
      return;
    }

    setWorking(true);
    setStatus("Unlocking on this device…");
    try {
      const plaintext = await window.MurphyCredentialCrypto.decryptString(token, password);
      const parsed = JSON.parse(plaintext);
      credentials = validateCredentials(parsed);
      encryptedToken = token;
      el.unlockPassword.value = "";
      el.showPassword.checked = false;
      el.unlockPassword.type = "password";

      window.murphyDashboardRequest = requestApi;
      el.unlockScreen.hidden = true;
      el.dashboardShell.hidden = false;
      scheduleAutoLock();
      await window.MurphyPublicDashboard.start(credentials.dashboardConfig, requestApi);
    } catch (error) {
      clearCredentials();
      el.unlockScreen.hidden = false;
      el.dashboardShell.hidden = true;
      setStatus(
        error instanceof SyntaxError
          ? "The decrypted string is not a Murphy dashboard connection bundle."
          : error.message || "The dashboard could not be unlocked.",
        true,
      );
    } finally {
      setWorking(false);
    }
  }

  function validateCredentials(value) {
    if (
      !value ||
      value.type !== "murphy-classroom-pass-dashboard" ||
      value.version !== 1 ||
      typeof value.apiKey !== "string" ||
      value.apiKey.length < 16 ||
      value.apiKey.length > 200
    ) {
      throw new Error("The decrypted string is not a valid Murphy dashboard connection bundle.");
    }

    let url;
    try {
      url = new URL(value.appsScriptUrl);
    } catch {
      throw new Error("The encrypted Google Apps Script URL is invalid.");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "script.google.com" ||
      !/^\/macros\/s\/[^/]+\/exec$/.test(url.pathname)
    ) {
      throw new Error("The encrypted Google Apps Script URL is invalid.");
    }
    url.search = "";
    url.hash = "";

    const config = value.dashboardConfig;
    if (!config || typeof config !== "object" || !Array.isArray(config.students)) {
      throw new Error("The encrypted classroom settings are missing.");
    }
    const students = [...new Set(
      config.students.map((name) => String(name).trim().replace(/\s+/g, " ")).filter(Boolean),
    )];
    const classDays = Array.isArray(config.classDays)
      ? [...new Set(config.classDays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
      : [];
    if (!students.length || students.length > 500 || students.some((name) => name.length > 100)) {
      throw new Error("The encrypted student roster is invalid.");
    }
    if (
      !/^\d{2}:\d{2}$/.test(config.classStart || "") ||
      !/^\d{2}:\d{2}$/.test(config.classEnd || "") ||
      config.classStart >= config.classEnd ||
      !classDays.length
    ) {
      throw new Error("The encrypted class schedule is invalid.");
    }

    return {
      appsScriptUrl: url.toString(),
      apiKey: value.apiKey,
      dashboardConfig: {
        classroomName: String(config.classroomName || "Classroom").slice(0, 100),
        students,
        classStart: config.classStart,
        classEnd: config.classEnd,
        classDays,
        weekStartsOn: Number.isInteger(config.weekStartsOn) && config.weekStartsOn >= 0 && config.weekStartsOn <= 6
          ? config.weekStartsOn
          : 1,
      },
    };
  }

  async function requestApi(action, payload = {}) {
    if (!credentials) throw apiError("LOCKED", "The dashboard is locked. Unlock it again.");
    if (action === "report") return jsonpReport(payload);
    if (action === "adminReturn") return postTeacherCorrection(payload);
    throw apiError("BAD_ACTION", "That dashboard action is not allowed.");
  }

  function jsonpReport(payload) {
    return new Promise((resolve, reject) => {
      const callbackName = "__murphyJsonp_" + randomId();
      const script = document.createElement("script");
      let finished = false;
      const timeout = window.setTimeout(() => {
        finish();
        reject(apiError(
          "SYNC_TIMEOUT",
          "Google did not answer. Update and redeploy Code.gs, then check the Apps Script URL and internet connection.",
        ));
      }, JSONP_TIMEOUT_MS);

      function finish() {
        if (finished) return;
        finished = true;
        window.clearTimeout(timeout);
        script.remove();
        try { delete window[callbackName]; } catch { window[callbackName] = undefined; }
      }

      window[callbackName] = (result) => {
        finish();
        if (!result || !result.ok) {
          reject(apiError(result?.code || "API_ERROR", result?.error || "Google could not return the dashboard report."));
          return;
        }
        resolve(result);
      };

      const url = new URL(credentials.appsScriptUrl);
      url.searchParams.set("action", "report");
      url.searchParams.set("key", credentials.apiKey);
      url.searchParams.set("payload", JSON.stringify(payload));
      url.searchParams.set("callback", callbackName);
      url.searchParams.set("_", String(Date.now()));
      script.async = true;
      script.referrerPolicy = "no-referrer";
      script.src = url.toString();
      script.onerror = () => {
        finish();
        reject(apiError(
          "BROWSER_ENDPOINT_ERROR",
          "The browser report endpoint is unavailable. Copy the updated Code.gs into Apps Script and deploy a new version.",
        ));
      };
      document.head.appendChild(script);
    });
  }

  async function postTeacherCorrection(payload) {
    const form = new URLSearchParams({
      action: "adminReturn",
      key: credentials.apiKey,
      payload: JSON.stringify(payload),
    });
    try {
      await fetch(credentials.appsScriptUrl, {
        method: "POST",
        mode: "no-cors",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        redirect: "manual",
        body: form,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      const report = await jsonpReport({ maxRows: 10000 });
      const stillOpen = (report.visits || []).some((visit) => (
        String(visit.sessionId || "") === String(payload.sessionId || "") &&
        String(visit.student || "") === String(payload.student || "") &&
        String(visit.status || "").toUpperCase() === "OUT"
      ));
      if (stillOpen) {
        throw apiError(
          "CORRECTION_NOT_CONFIRMED",
          "Google did not confirm the correction. Refresh and try again; the record was not shown as changed.",
        );
      }
      return { ok: true, submitted: true };
    } catch (error) {
      if (error?.code) throw error;
      throw apiError("GOOGLE_UNREACHABLE", "The teacher correction could not reach Google. Check the internet connection.");
    }
  }

  function tokenFromHash() {
    let raw = window.location.hash.slice(1);
    if (!raw) return "";
    if (raw.startsWith("token=")) raw = raw.slice(6);
    try { raw = decodeURIComponent(raw); } catch { /* Use the literal fragment. */ }
    return raw.startsWith(window.MurphyCredentialCrypto.formatPrefix) ? raw : "";
  }

  function scrubHash() {
    if (!window.location.hash) return;
    try {
      window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
    } catch {
      // Some file:// browsers do not allow history replacement. The encrypted value is not plaintext.
    }
  }

  function scheduleAutoLock() {
    window.clearTimeout(lockTimer);
    lockTimer = window.setTimeout(lockNow, AUTO_LOCK_MS);
  }

  function lockNow() {
    clearCredentials();
    const url = new URL(window.location.href);
    url.hash = encryptedToken;
    window.location.replace(url.href);
  }

  function clearCredentials() {
    credentials = null;
    window.murphyDashboardRequest = null;
    window.clearTimeout(lockTimer);
    lockTimer = 0;
  }

  function setWorking(working) {
    el.unlockButton.disabled = working;
    el.unlockButton.textContent = working ? "Unlocking…" : "Unlock dashboard";
  }

  function setStatus(message, isError = false) {
    el.unlockStatus.textContent = message;
    el.unlockStatus.className = "form-status" + (isError ? " is-error" : "");
  }

  function apiError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function randomId() {
    const bytes = window.crypto.getRandomValues(new Uint8Array(12));
    return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  function toCamel(value) {
    return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  }
})();
