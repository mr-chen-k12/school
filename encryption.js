(() => {
  "use strict";

  const el = {};
  document.addEventListener("DOMContentLoaded", init);

  function init() {
    [
      "encryption-form", "apps-script-url", "read-key", "classroom-name", "student-roster",
      "class-start", "class-end", "bundle-password", "confirm-password", "encrypt-button",
      "generator-status", "result-panel", "encrypted-output", "dashboard-link", "copy-string",
      "copy-link", "config-import",
    ].forEach((id) => { el[toCamel(id)] = document.getElementById(id); });

    el.encryptionForm.addEventListener("submit", encryptBundle);
    el.copyString.addEventListener("click", () => copyText(el.encryptedOutput.value, "Encrypted string copied."));
    el.copyLink.addEventListener("click", () => copyText(el.dashboardLink.value, "Dashboard link copied."));
    el.configImport.addEventListener("change", importDashboardConfig);

    if (!window.MurphyCredentialCrypto?.isSupported()) {
      setStatus("Encryption is unavailable in this browser. Use current Firefox, Chrome, or Edge over HTTPS or localhost.", true);
      el.encryptButton.disabled = true;
    }
  }

  async function encryptBundle(event) {
    event.preventDefault();
    el.resultPanel.hidden = true;
    setStatus("Checking settings…");

    try {
      const credentials = readAndValidateForm();
      const password = el.bundlePassword.value;
      if (password.length < 12) throw new Error("Use a password with at least 12 characters.");
      if (password !== el.confirmPassword.value) throw new Error("The two password entries do not match.");

      setWorking(true);
      setStatus("Encrypting on this device…");
      const token = await window.MurphyCredentialCrypto.encryptString(JSON.stringify(credentials), password);
      el.encryptedOutput.value = token;
      el.dashboardLink.value = makeDashboardLink(token);
      el.resultPanel.hidden = false;
      el.readKey.value = "";
      el.bundlePassword.value = "";
      el.confirmPassword.value = "";
      setStatus("Encrypted. Save the string or dashboard link separately from the password.", false, true);
      el.resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      setStatus(error.message || "The connection bundle could not be encrypted.", true);
    } finally {
      setWorking(false);
    }
  }

  function readAndValidateForm() {
    const rawUrl = el.appsScriptUrl.value.trim();
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error("Enter the Google Apps Script deployment URL ending in /exec.");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "script.google.com" ||
      !/^\/macros\/s\/[^/]+\/exec$/.test(url.pathname)
    ) {
      throw new Error("Use the HTTPS Google Apps Script deployment URL ending in /exec.");
    }
    url.search = "";
    url.hash = "";

    const apiKey = el.readKey.value.trim();
    if (apiKey.length < 16 || apiKey.length > 200) throw new Error("Enter the dashboard read key from initializeProject.");

    const students = [...new Set(
      el.studentRoster.value
        .split(/\r?\n/)
        .map((name) => name.trim().replace(/\s+/g, " "))
        .filter(Boolean),
    )];
    if (!students.length) throw new Error("Add at least one student name.");
    if (students.length > 500) throw new Error("The roster is too large for this page.");
    if (students.some((name) => name.length > 100)) throw new Error("Student names must be 100 characters or fewer.");

    const classStart = el.classStart.value;
    const classEnd = el.classEnd.value;
    if (!/^\d{2}:\d{2}$/.test(classStart) || !/^\d{2}:\d{2}$/.test(classEnd) || classStart >= classEnd) {
      throw new Error("Choose a class end time later than the start time.");
    }
    const classDays = [...document.querySelectorAll("[name='class-day']:checked")]
      .map((input) => Number(input.value))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
    if (!classDays.length) throw new Error("Choose at least one class day.");

    return {
      type: "murphy-classroom-pass-dashboard",
      version: 1,
      appsScriptUrl: url.toString(),
      apiKey,
      dashboardConfig: {
        classroomName: el.classroomName.value.trim().slice(0, 100) || "Classroom",
        students,
        classStart,
        classEnd,
        classDays,
        weekStartsOn: 1,
      },
    };
  }

  async function importDashboardConfig(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const config = JSON.parse(await file.text());
      if (!config || typeof config !== "object" || !Array.isArray(config.students)) {
        throw new Error("That file is not a dashboard-config.json file.");
      }
      el.classroomName.value = String(config.classroomName || "Classroom");
      el.studentRoster.value = config.students.map(String).join("\n");
      if (/^\d{2}:\d{2}$/.test(config.classStart || "")) el.classStart.value = config.classStart;
      if (/^\d{2}:\d{2}$/.test(config.classEnd || "")) el.classEnd.value = config.classEnd;
      const selectedDays = new Set(Array.isArray(config.classDays) ? config.classDays.map(Number) : [1, 2, 3, 4, 5]);
      document.querySelectorAll("[name='class-day']").forEach((input) => {
        input.checked = selectedDays.has(Number(input.value));
      });
      setStatus("Dashboard settings imported locally. The file was not uploaded.", false, true);
    } catch (error) {
      setStatus(error.message || "The dashboard settings file could not be read.", true);
    } finally {
      event.target.value = "";
    }
  }

  function makeDashboardLink(token) {
    const url = new URL("dashboard.html", window.location.href);
    url.search = "";
    url.hash = token;
    return url.href;
  }

  async function copyText(value, successMessage) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const helper = document.createElement("textarea");
      helper.value = value;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      const copied = document.execCommand("copy");
      helper.remove();
      if (!copied) {
        setStatus("Copy was blocked. Select the text and copy it manually.", true);
        return;
      }
    }
    setStatus(successMessage, false, true);
  }

  function setWorking(working) {
    el.encryptButton.disabled = working;
    el.encryptButton.textContent = working ? "Encrypting…" : "Create encrypted string";
  }

  function setStatus(message, isError = false, isSuccess = false) {
    el.generatorStatus.textContent = message;
    el.generatorStatus.className = "form-status" + (isError ? " is-error" : isSuccess ? " is-success" : "");
  }

  function toCamel(value) {
    return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  }
})();
