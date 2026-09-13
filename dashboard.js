(() => {
  "use strict";

  const state = {
    config: null,
    apiRequest: null,
    visits: [],
    range: "week",
    query: "",
    demoMode: false,
    loading: false,
    toastTimer: null,
  };

  const el = {};
  let started = false;
  window.MurphyPublicDashboard = Object.freeze({ start: init });

  async function init(config, apiRequest) {
    if (started) return;
    started = true;
    cacheElements();
    bindEvents();
    try {
      state.config = config;
      state.apiRequest = apiRequest;
      if (!state.config || typeof state.config !== "object") throw new Error("The encrypted dashboard settings are missing.");
      if (typeof state.apiRequest !== "function") throw new Error("The encrypted Google connection is missing.");
      validateConfig();
      el.classroomName.textContent = `${state.config.classroomName || "Classroom"} overview`;
      await refreshData();
      window.setInterval(() => {
        if (!state.demoMode && !state.loading) refreshData(true);
      }, 60000);
    } catch (error) {
      setSync("error", "Setup error");
      showToast(error.message);
    }
  }

  function cacheElements() {
    const ids = [
      "classroom-name", "sync-state", "refresh-button", "mode-banner", "out-count", "last-updated",
      "out-list", "student-filter", "export-button", "metric-trips", "metric-trips-note", "metric-minutes",
      "metric-minutes-note", "metric-average", "metric-average-note", "metric-presence",
      "metric-presence-note", "trend-chart", "reason-list", "presence-explainer", "student-table-body",
      "activity-count", "activity-list", "toast",
    ];
    ids.forEach((id) => { el[toCamel(id)] = document.getElementById(id); });
    el.rangeButtons = [...document.querySelectorAll("[data-range]")];
  }

  function bindEvents() {
    el.refreshButton.addEventListener("click", () => refreshData());
    el.rangeButtons.forEach((button) => button.addEventListener("click", () => {
      state.range = button.dataset.range;
      el.rangeButtons.forEach((item) => item.classList.toggle("is-active", item === button));
      render();
    }));
    el.studentFilter.addEventListener("input", () => {
      state.query = el.studentFilter.value.trim().toLowerCase();
      render();
    });
    el.exportButton.addEventListener("click", exportCurrentView);
    el.outList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-clear-session]");
      if (button) clearOpenVisit(button);
    });
  }

  function validateConfig() {
    const students = (state.config.students || []).map((name) => String(name).trim()).filter(Boolean);
    if (!students.length) throw new Error("The encrypted roster does not contain any students.");
    state.config.students = [...new Set(students)].sort((a, b) => a.localeCompare(b));
    if (!/^\d{2}:\d{2}$/.test(state.config.classStart || "") || !/^\d{2}:\d{2}$/.test(state.config.classEnd || "")) {
      throw new Error("The encrypted class times must use 24-hour HH:MM format.");
    }
    if (!Array.isArray(state.config.classDays) || !state.config.classDays.length) {
      throw new Error("The encrypted class schedule does not contain any weekdays.");
    }
  }

  async function refreshData(silent = false) {
    if (state.loading) return;
    state.loading = true;
    el.refreshButton.classList.add("is-busy");
    el.refreshButton.disabled = true;
    if (!silent) setSync("", "Refreshing…");
    try {
      const result = await callApi("report", { maxRows: 10000 });
      applyReportRoster(result.roster);
      state.visits = normalizeVisits(result.visits || []);
      state.demoMode = false;
      el.modeBanner.hidden = true;
      setSync("online", result.truncated ? "Synced · newest 10,000 records" : "Google Sheet synced");
      render();
    } catch (error) {
      if (error.code === "DEMO_MODE") {
        state.demoMode = true;
        state.visits = makeDemoVisits();
        el.modeBanner.hidden = false;
        setSync("warning", "Demo data only");
        render();
      } else {
        setSync("error", "Sync unavailable");
        if (!silent || !state.visits.length) showToast(error.message);
        if (state.visits.length) render();
      }
    } finally {
      state.loading = false;
      el.refreshButton.classList.remove("is-busy");
      el.refreshButton.disabled = false;
    }
  }

  async function callApi(action, payload = {}) {
    try {
      return await state.apiRequest(action, payload);
    } catch (cause) {
      if (cause instanceof Error) throw cause;
      const error = new Error("The class log could not complete that request.");
      error.code = "API_ERROR";
      throw error;
    }
  }

  function normalizeVisits(visits) {
    return visits
      .map((visit) => ({
        sessionId: String(visit.sessionId || ""),
        student: String(visit.student || "Unknown student"),
        studentKey: String(visit.studentKey || visit.student || ""),
        outTime: visit.outTime,
        inTime: visit.inTime || null,
        reason: String(visit.reason || "Other"),
        otherDetail: String(visit.otherDetail || ""),
        durationMinutes: Number(visit.durationMinutes || 0),
        status: normalizeStatus(visit.status),
        device: String(visit.device || ""),
      }))
      .filter((visit) => !Number.isNaN(new Date(visit.outTime).getTime()))
      .sort((a, b) => new Date(b.outTime) - new Date(a.outTime));
  }

  function applyReportRoster(rawRoster) {
    if (!Array.isArray(rawRoster)) return;
    const students = [...new Set(rawRoster
      .filter((entry) => entry && typeof entry === "object" && entry.active !== false)
      .map((entry) => String(entry.name || entry.displayName || entry.key || "").trim())
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    if (students.length) state.config.students = students;
  }

  function render() {
    const now = new Date();
    const start = getRangeStart(state.range, now);
    const datedVisits = state.visits.filter((visit) => !start || new Date(visit.outTime) >= start);
    const visibleStudents = state.config.students.filter((name) => name.toLowerCase().includes(state.query));
    const visibleNames = new Set(visibleStudents);
    const visibleVisits = state.query ? datedVisits.filter((visit) => visibleNames.has(visit.student)) : datedVisits;
    const allStats = buildStudentStats(datedVisits, start, now);
    const selectedStats = allStats.filter((stat) => visibleNames.has(stat.student));
    const classAverage = average(allStats.map((stat) => stat.presence).filter(Number.isFinite));
    const viewPresence = average(selectedStats.map((stat) => stat.presence).filter(Number.isFinite));
    const totalMinutes = visibleVisits.reduce((sum, visit) => sum + visitMinutes(visit, now), 0);

    renderOutNow(now);
    renderMetrics(visibleVisits, selectedStats, totalMinutes, viewPresence);
    renderTrend(visibleVisits, start, now);
    renderReasons(visibleVisits);
    renderStudentTable(selectedStats, classAverage);
    renderActivity(visibleVisits, now);
    el.lastUpdated.textContent = `Updated ${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }

  function renderOutNow(now) {
    const active = state.visits.filter((visit) => visit.status === "OUT").sort((a, b) => new Date(a.outTime) - new Date(b.outTime));
    el.outCount.textContent = String(active.length);
    el.outList.replaceChildren();
    if (!active.length) {
      const empty = document.createElement("div");
      empty.className = "out-empty";
      empty.textContent = "Everyone is currently marked in class.";
      el.outList.appendChild(empty);
      return;
    }
    active.forEach((visit) => {
      const card = document.createElement("div");
      card.className = "out-card";
      card.innerHTML = `
        <span class="out-card-avatar">${escapeHtml(initials(visit.student))}</span>
        <span class="out-card-copy">
          <strong>${escapeHtml(visit.student)}</strong>
          <span>${escapeHtml(visit.reason)} · ${escapeHtml(formatDuration(visitMinutes(visit, now)))}</span>
        </span>
        <button class="clear-out-button" type="button" data-clear-session="${escapeHtml(visit.sessionId)}" data-student="${escapeHtml(visit.student)}" data-student-key="${escapeHtml(visit.studentKey)}">Mark returned</button>
      `;
      el.outList.appendChild(card);
    });
  }

  async function clearOpenVisit(button) {
    const sessionId = button.dataset.clearSession;
    const student = button.dataset.student;
    const studentKey = button.dataset.studentKey || student;
    if (!sessionId || !student || state.loading) return;
    if (!window.confirm(`Mark ${student} as returned now? This will be recorded as a teacher correction.`)) return;

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      if (state.demoMode) {
        const visit = state.visits.find((item) => item.sessionId === sessionId && item.status === "OUT");
        if (!visit) throw new Error("That student is no longer marked out.");
        const now = new Date();
        visit.inTime = now.toISOString();
        visit.durationMinutes = Math.max(0, (now - new Date(visit.outTime)) / 60000);
        visit.status = "RETURNED_BY_TEACHER";
        render();
      } else {
        await callApi("adminReturn", { sessionId, student, studentKey, requestId: createRequestId() });
        await refreshData(true);
      }
      showToast(`${student} was marked returned. The correction is preserved in the audit trail.`, false);
    } catch (error) {
      showToast(error.message, true);
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  function renderMetrics(visits, stats, totalMinutes, presence) {
    const rangeLabel = { today: "Today", week: "This week", month: "This month", all: "All recorded time" }[state.range];
    el.metricTrips.textContent = formatNumber(visits.length);
    el.metricTripsNote.textContent = state.query ? `${rangeLabel} · filtered student` : rangeLabel;
    el.metricMinutes.textContent = formatDuration(totalMinutes, true);
    el.metricMinutesNote.textContent = `${stats.length} student${stats.length === 1 ? "" : "s"} in view`;
    el.metricAverage.textContent = visits.length ? formatDuration(totalMinutes / visits.length, true) : "0 min";
    el.metricAverageNote.textContent = "Completed and active trips";
    el.metricPresence.textContent = Number.isFinite(presence) ? `${presence.toFixed(1)}%` : "N/A";
    el.metricPresenceNote.textContent = Number.isFinite(presence)
      ? `${state.config.classStart}–${state.config.classEnd} configured window`
      : "No configured class time has elapsed";
  }

  function renderTrend(visits, start, now) {
    const buckets = makeBuckets(state.range, start, now);
    buckets.forEach((bucket) => {
      bucket.count = visits.filter((visit) => {
        const time = new Date(visit.outTime);
        return time >= bucket.start && time < bucket.end;
      }).length;
    });
    el.trendChart.replaceChildren();
    if (!buckets.length) {
      el.trendChart.innerHTML = '<div class="chart-empty">No trips in this range.</div>';
      return;
    }
    const maximum = Math.max(1, ...buckets.map((bucket) => bucket.count));
    buckets.forEach((bucket) => {
      const column = document.createElement("div");
      column.className = "trend-column";
      const height = bucket.count ? Math.max(5, (bucket.count / maximum) * 100) : 2;
      column.innerHTML = `
        <div class="trend-bar-wrap">
          <div class="trend-bar" style="height:${height}%" data-value="${bucket.count}" title="${escapeHtml(bucket.longLabel)}: ${bucket.count} trips"></div>
        </div>
        <span class="trend-label">${escapeHtml(bucket.label)}</span>
      `;
      el.trendChart.appendChild(column);
    });
  }

  function renderReasons(visits) {
    const counts = new Map();
    visits.forEach((visit) => counts.set(visit.reason, (counts.get(visit.reason) || 0) + 1));
    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    el.reasonList.replaceChildren();
    if (!entries.length) {
      el.reasonList.innerHTML = '<div class="chart-empty">No reasons to summarize.</div>';
      return;
    }
    const maximum = Math.max(...entries.map((entry) => entry[1]));
    entries.forEach(([reason, count]) => {
      const row = document.createElement("div");
      row.className = "reason-row";
      row.innerHTML = `
        <span class="reason-name" title="${escapeHtml(reason)}">${escapeHtml(reason)}</span>
        <span class="reason-track"><span class="reason-fill" style="width:${(count / maximum) * 100}%"></span></span>
        <span class="reason-count">${count}</span>
      `;
      el.reasonList.appendChild(row);
    });
  }

  function renderStudentTable(stats, classAverage) {
    el.studentTableBody.replaceChildren();
    if (!stats.length) {
      el.studentTableBody.innerHTML = '<tr><td colspan="6" class="table-empty">No students match this filter.</td></tr>';
      return;
    }
    [...stats]
      .sort((a, b) => b.trips - a.trips || b.minutes - a.minutes || a.student.localeCompare(b.student))
      .forEach((stat) => {
        const delta = Number.isFinite(stat.presence) && Number.isFinite(classAverage) ? stat.presence - classAverage : null;
        const row = document.createElement("tr");
        row.innerHTML = `
          <td>${escapeHtml(stat.student)}</td>
          <td>${stat.trips}</td>
          <td>${escapeHtml(formatDuration(stat.minutes, true))}</td>
          <td>${stat.trips ? escapeHtml(formatDuration(stat.minutes / stat.trips, true)) : "—"}</td>
          <td>${Number.isFinite(stat.presence) ? `
            <span class="presence-cell">
              <span class="presence-meter"><span style="width:${clamp(stat.presence, 0, 100)}%"></span></span>
              ${stat.presence.toFixed(1)}%
            </span>` : "N/A"}</td>
          <td class="${delta === null ? "" : delta >= 0 ? "delta-positive" : "delta-negative"}">${formatDelta(delta)}</td>
        `;
        el.studentTableBody.appendChild(row);
      });
    el.presenceExplainer.textContent = Number.isFinite(classAverage)
      ? `Class average for this view: ${classAverage.toFixed(1)}%. Presence is estimated from logged time out during configured class hours.`
      : "Presence will appear after time has elapsed inside the configured class window.";
  }

  function renderActivity(visits, now) {
    const recent = visits.slice(0, 12);
    el.activityCount.textContent = `${formatNumber(visits.length)} record${visits.length === 1 ? "" : "s"} in view`;
    el.activityList.replaceChildren();
    if (!recent.length) {
      el.activityList.innerHTML = '<div class="table-empty">No activity in this view.</div>';
      return;
    }
    recent.forEach((visit) => {
      const row = document.createElement("div");
      row.className = "activity-row";
      const reason = visit.reason === "Other" && visit.otherDetail ? `Other · ${visit.otherDetail}` : visit.reason;
      row.innerHTML = `
        <div class="activity-person">
          <span class="activity-avatar">${escapeHtml(initials(visit.student))}</span>
          <span><strong>${escapeHtml(visit.student)}</strong><span>${escapeHtml(reason)}</span></span>
        </div>
        <span class="activity-time">Out ${escapeHtml(formatDateTime(visit.outTime))}</span>
        <span class="activity-duration">${escapeHtml(formatDuration(visitMinutes(visit, now), true))}</span>
        <span class="activity-status${visit.status === "OUT" ? " is-out" : visit.status === "RETURNED_BY_TEACHER" ? " is-corrected" : ""}">${activityStatusLabel(visit.status)}</span>
      `;
      el.activityList.appendChild(row);
    });
  }

  function buildStudentStats(visits, start, now) {
    const scheduleStart = start || getEarliestDay(visits, now);
    const scheduledMinutes = getScheduledMinutes(scheduleStart, now);
    return state.config.students.map((student) => {
      const studentVisits = visits.filter((visit) => visit.student === student);
      const minutes = studentVisits.reduce((sum, visit) => sum + visitMinutes(visit, now), 0);
      const scheduledOutMinutes = studentVisits.reduce(
        (sum, visit) => sum + getScheduledOutMinutes(visit, scheduleStart, now),
        0,
      );
      return {
        student,
        trips: studentVisits.length,
        minutes,
        presence: scheduledMinutes > 0 ? clamp(100 * (1 - scheduledOutMinutes / scheduledMinutes), 0, 100) : null,
      };
    });
  }

  function getScheduledMinutes(from, to) {
    let total = 0;
    forEachDay(from, to, (day) => {
      if (!state.config.classDays.includes(day.getDay())) return;
      const window = scheduleWindow(day);
      total += overlapMinutes(from, to, window.start, window.end);
    });
    return total;
  }

  function getScheduledOutMinutes(visit, from, to) {
    const out = new Date(visit.outTime);
    const returned = visit.inTime ? new Date(visit.inTime) : to;
    const visitStart = new Date(Math.max(out.getTime(), from.getTime()));
    const visitEnd = new Date(Math.min(returned.getTime(), to.getTime()));
    if (visitEnd <= visitStart) return 0;
    let total = 0;
    forEachDay(visitStart, visitEnd, (day) => {
      if (!state.config.classDays.includes(day.getDay())) return;
      const window = scheduleWindow(day);
      total += overlapMinutes(visitStart, visitEnd, window.start, window.end);
    });
    return total;
  }

  function scheduleWindow(day) {
    const start = new Date(day);
    const end = new Date(day);
    const [startHour, startMinute] = state.config.classStart.split(":").map(Number);
    const [endHour, endMinute] = state.config.classEnd.split(":").map(Number);
    start.setHours(startHour, startMinute, 0, 0);
    end.setHours(endHour, endMinute, 0, 0);
    return { start, end };
  }

  function overlapMinutes(aStart, aEnd, bStart, bEnd) {
    return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart)) / 60000;
  }

  function forEachDay(from, to, callback) {
    const cursor = startOfDay(from);
    const finalDay = startOfDay(to);
    let guard = 0;
    while (cursor <= finalDay && guard < 3700) {
      callback(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
      guard += 1;
    }
  }

  function getRangeStart(range, now) {
    if (range === "all") return null;
    const start = startOfDay(now);
    if (range === "week") {
      const weekStartsOn = Number.isInteger(state.config.weekStartsOn) ? state.config.weekStartsOn : 1;
      const offset = (start.getDay() - weekStartsOn + 7) % 7;
      start.setDate(start.getDate() - offset);
    } else if (range === "month") {
      start.setDate(1);
    }
    return start;
  }

  function makeBuckets(range, start, now) {
    const buckets = [];
    if (range === "today") {
      const dayStart = startOfDay(now);
      for (let hour = 0; hour < 24; hour += 1) {
        const bucketStart = new Date(dayStart);
        bucketStart.setHours(hour);
        const bucketEnd = new Date(bucketStart);
        bucketEnd.setHours(hour + 1);
        buckets.push({ start: bucketStart, end: bucketEnd, label: bucketStart.toLocaleTimeString([], { hour: "numeric" }), longLabel: bucketStart.toLocaleString() });
      }
      return buckets;
    }
    if (range === "week") {
      for (let index = 0; index < 7; index += 1) {
        const bucketStart = new Date(start);
        bucketStart.setDate(start.getDate() + index);
        const bucketEnd = new Date(bucketStart);
        bucketEnd.setDate(bucketStart.getDate() + 1);
        buckets.push({ start: bucketStart, end: bucketEnd, label: bucketStart.toLocaleDateString([], { weekday: "short" }), longLabel: bucketStart.toLocaleDateString() });
      }
      return buckets;
    }
    if (range === "month") {
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      let cursor = new Date(start);
      let week = 1;
      while (cursor < monthEnd) {
        const bucketStart = new Date(cursor);
        const bucketEnd = new Date(Math.min(monthEnd.getTime(), bucketStart.getTime() + 7 * 86400000));
        buckets.push({ start: bucketStart, end: bucketEnd, label: `W${week}`, longLabel: `Week of ${bucketStart.toLocaleDateString()}` });
        cursor = bucketEnd;
        week += 1;
      }
      return buckets;
    }
    const earliest = getEarliestDay(state.visits, now);
    const monthCursor = new Date(earliest.getFullYear(), earliest.getMonth(), 1);
    const lastMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const months = [];
    while (monthCursor <= lastMonth && months.length < 120) {
      const bucketStart = new Date(monthCursor);
      const bucketEnd = new Date(bucketStart.getFullYear(), bucketStart.getMonth() + 1, 1);
      months.push({ start: bucketStart, end: bucketEnd, label: bucketStart.toLocaleDateString([], { month: "short", year: "2-digit" }), longLabel: bucketStart.toLocaleDateString([], { month: "long", year: "numeric" }) });
      monthCursor.setMonth(monthCursor.getMonth() + 1);
    }
    return months.slice(-12);
  }

  function getEarliestDay(visits, fallback) {
    if (!visits.length) return startOfDay(fallback);
    return startOfDay(new Date(Math.min(...visits.map((visit) => new Date(visit.outTime).getTime()))));
  }

  function startOfDay(value) {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function visitMinutes(visit, now) {
    const stored = Number(visit.durationMinutes || 0);
    if (visit.status !== "OUT" && stored >= 0) return stored;
    const end = visit.inTime ? new Date(visit.inTime) : now;
    return Math.max(0, (end - new Date(visit.outTime)) / 60000);
  }

  function exportCurrentView() {
    const start = getRangeStart(state.range, new Date());
    const students = new Set(state.config.students.filter((name) => name.toLowerCase().includes(state.query)));
    const visits = state.visits.filter((visit) => (!start || new Date(visit.outTime) >= start) && (!state.query || students.has(visit.student)));
    const rows = [
      ["Student", "Out time", "In time", "Reason", "Other detail", "Duration minutes", "Status", "Session ID"],
      ...visits.map((visit) => [visit.student, visit.outTime, visit.inTime || "", visit.reason, visit.otherDetail, Math.round(visitMinutes(visit, new Date())), visit.status, visit.sessionId]),
    ];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `classroom-pass-${state.range}-${localDateKey(new Date())}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function makeDemoVisits() {
    const students = state.config.students;
    const reasons = ["Bathroom", "Locker", "Nurse", "Bathroom", "Other"];
    const now = new Date();
    const visits = [];
    for (let index = 0; index < 46; index += 1) {
      const out = new Date(now);
      out.setDate(now.getDate() - ((index * 5 + 1) % 34));
      out.setHours(8 + (index % 7), (index * 11) % 60, 0, 0);
      if (out > now) out.setDate(out.getDate() - 1);
      const duration = 4 + ((index * 7) % 24);
      const returned = new Date(out.getTime() + duration * 60000);
      visits.push({
        sessionId: `demo-${index}`,
        student: students[(index * 3 + index % 2) % students.length],
        outTime: out.toISOString(),
        inTime: returned.toISOString(),
        reason: reasons[index % reasons.length],
        otherDetail: index % reasons.length === 4 ? "Main office" : "",
        durationMinutes: duration,
        status: "RETURNED",
        device: "Demo kiosk",
      });
    }
    const activeOut = new Date(now.getTime() - 8 * 60000);
    visits.push({
      sessionId: "demo-active",
      student: students[Math.min(3, students.length - 1)],
      outTime: activeOut.toISOString(),
      inTime: null,
      reason: "Bathroom",
      otherDetail: "",
      durationMinutes: 0,
      status: "OUT",
      device: "Demo kiosk",
    });
    return normalizeVisits(visits);
  }

  function setSync(kind, message) {
    el.syncState.className = `sync-state${kind ? ` is-${kind}` : ""}`;
    el.syncState.querySelector("span:last-child").textContent = message;
  }

  function showToast(message, isError = true) {
    window.clearTimeout(state.toastTimer);
    el.toast.textContent = message;
    el.toast.classList.toggle("is-success", !isError);
    el.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => { el.toast.hidden = true; }, 7000);
  }

  function normalizeStatus(value) {
    const status = String(value || "").toUpperCase();
    if (status === "OUT") return "OUT";
    if (status === "RETURNED_BY_TEACHER") return "RETURNED_BY_TEACHER";
    return "RETURNED";
  }

  function activityStatusLabel(status) {
    if (status === "OUT") return "Out now";
    if (status === "RETURNED_BY_TEACHER") return "Teacher-cleared";
    return "Returned";
  }

  function formatDuration(minutes, compact = false) {
    const rounded = Math.max(0, Math.round(Number(minutes) || 0));
    if (rounded < 60) return `${rounded} min`;
    const hours = Math.floor(rounded / 60);
    const remainder = rounded % 60;
    if (compact) return `${hours}h${remainder ? ` ${remainder}m` : ""}`;
    return `${hours} hr${hours === 1 ? "" : "s"}${remainder ? ` ${remainder} min` : ""}`;
  }

  function formatDateTime(value) {
    const date = new Date(value);
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function formatDelta(value) {
    if (!Number.isFinite(value)) return "—";
    if (Math.abs(value) < 0.05) return "At average";
    return `${value > 0 ? "+" : ""}${value.toFixed(1)} pts`;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(value);
  }

  function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function initials(name) {
    return String(name).split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 3).toUpperCase();
  }

  function localDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return `"${text.replace(/"/g, '""')}"`;
  }

  function createRequestId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    })[character]);
  }

  function toCamel(value) {
    return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  }
})();
