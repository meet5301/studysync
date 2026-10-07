const $ = (s) => document.querySelector(s);
const state = { token: localStorage.getItem("studysync_token"), user: null, rooms: [], room: null, socket: null, timerBase: 0, timerStartedAt: null, timerInterval: null, stats: null };
const api = async (url, options = {}) => {
  const headers = { "Content-Type": "application/json", ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
};
function toast(message, error = false) {
  const el = $("#toast"); el.textContent = message; el.classList.remove("hidden", "error");
  if (error) el.classList.add("error");
  clearTimeout(toast.timeout); toast.timeout = setTimeout(() => el.classList.add("hidden"), 3200);
}
function message(el, text, error = false) {
  el.textContent = text; el.classList.remove("hidden", "error", "success"); el.classList.add(error ? "error" : "success");
}
function setAuthTab(tab) {
  document.querySelectorAll(".auth-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $("#login-form").classList.toggle("hidden", tab !== "login");
  $("#register-form").classList.toggle("hidden", tab !== "register");
  $("#auth-message").classList.add("hidden");
}
document.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => setAuthTab(b.dataset.tab)));
async function handleAuth(e, mode) {
  e.preventDefault();
  const form = e.currentTarget, data = Object.fromEntries(new FormData(form).entries());
  try {
    const result = await api(`/api/auth/${mode}`, { method: "POST", body: JSON.stringify(data) });
    state.token = result.token; state.user = result.user; localStorage.setItem("studysync_token", state.token);
    await loadDashboard();
  } catch (err) { message($("#auth-message"), err.message, true); }
}
$("#login-form").addEventListener("submit", e => handleAuth(e, "login"));
$("#register-form").addEventListener("submit", e => handleAuth(e, "register"));
$("#logout-btn").addEventListener("click", () => {
  if (state.socket) state.socket.disconnect();
  localStorage.removeItem("studysync_token"); state.token = null; state.user = null; state.room = null;
  showAuth();
});
function showAuth() {
  $("#auth-view").classList.remove("hidden"); $("#app-view").classList.add("hidden"); $("#header-user").classList.add("hidden");
}
async function loadDashboard() {
  try {
    const data = await api("/api/me");
    state.user = data.user; state.rooms = data.rooms;
    $("#auth-view").classList.add("hidden"); $("#app-view").classList.remove("hidden"); $("#header-user").classList.remove("hidden");
    $("#header-name").textContent = state.user.name; $("#welcome-name").textContent = state.user.name.split(" ")[0];
    $("#today-date").textContent = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(new Date());
    renderRooms();
    const lastCode = sessionStorage.getItem("studysync_last_room");
    if (lastCode && state.rooms.some(r => r.code === lastCode)) await openRoom(lastCode);
  } catch (e) { localStorage.removeItem("studysync_token"); state.token = null; showAuth(); }
}
function renderRooms() {
  const wrap = $("#existing-rooms-wrap"), list = $("#existing-rooms");
  if (!state.rooms.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden"); list.innerHTML = "";
  state.rooms.forEach(r => {
    const b = document.createElement("button"); b.className = "room-chip";
    const strong = document.createElement("strong"); strong.textContent = "✿ " + r.name;
    const small = document.createElement("small"); small.textContent = `Code ${r.code} · ${r.memberCount} member${r.memberCount === 1 ? "" : "s"}`;
    b.append(strong, small); b.addEventListener("click", () => openRoom(r.code)); list.append(b);
  });
}
$("#create-room-form").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const name = new FormData(e.currentTarget).get("name");
    const { room } = await api("/api/rooms", { method: "POST", body: JSON.stringify({ name }) });
    toast(`Your private room is ready! Code: ${room.code}`);
    await loadDashboard(); await openRoom(room.code);
  } catch (err) { showNotice(err.message, true); }
});
$("#join-room-form").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const code = new FormData(e.currentTarget).get("code");
    const { room } = await api("/api/rooms/join", { method: "POST", body: JSON.stringify({ code }) });
    await loadDashboard(); await openRoom(room.code); toast("Welcome to your shared garden 🌱");
  } catch (err) { showNotice(err.message, true); }
});
function showNotice(text, error = false) {
  const el = $("#notice"); message(el, text, error); el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 4500);
}
$("#back-rooms").addEventListener("click", () => {
  $("#room-view").classList.add("hidden"); $("#room-chooser").classList.remove("hidden");
  sessionStorage.removeItem("studysync_last_room");
  if (state.socket) { state.socket.disconnect(); state.socket = null; }
  state.room = null; clearInterval(state.timerInterval);
});
$("#share-code").addEventListener("click", async () => {
  if (!state.room) return;
  try {
    await navigator.clipboard.writeText(state.room.code); toast("Room code copied — send it to your buddy!");
  } catch { prompt("Share this private room code with your buddy:", state.room.code); }
});
async function openRoom(code) {
  try {
    const { room } = await api(`/api/rooms/${code}`);
    state.room = room; sessionStorage.setItem("studysync_last_room", code);
    $("#room-chooser").classList.add("hidden"); $("#room-view").classList.remove("hidden");
    $("#room-name").textContent = room.name; $("#room-code").textContent = room.code;
    $("#my-name").textContent = state.user.name; $("#my-avatar").textContent = state.user.name[0].toUpperCase();
    $("#settings-form").elements.dailyGoalMinutes.value = room.dailyGoalMinutes;
    $("#settings-form").elements.weeklyGoalHours.value = room.weeklyGoalHours;
    if (state.socket) state.socket.disconnect();
    state.socket = io({ auth: { token: state.token } });
    state.socket.on("connect", () => state.socket.emit("room:join", code));
    state.socket.on("room:update", async incoming => {
      if (state.room && incoming.code === state.room.code) {
        if (!incoming.members.some(m => m.id === state.user.id)) {
          toast("You were removed from this room by the creator.", true);
          $("#room-view").classList.add("hidden"); $("#room-chooser").classList.remove("hidden");
          sessionStorage.removeItem("studysync_last_room");
          if (state.socket) { state.socket.disconnect(); state.socket = null; }
          state.room = null; clearInterval(state.timerInterval);
          await loadDashboard();
          return;
        }
        state.room = incoming; renderRoom();
      }
    });
    state.socket.on("room:presence", data => toast(`${data.name} opened the study garden 🌷`));
    state.socket.on("app:error", err => toast(err, true));
    state.socket.on("connect_error", () => toast("Live connection interrupted. Reconnecting…", true));
    await refreshStats(); renderRoom(); clearInterval(state.timerInterval); state.timerInterval = setInterval(renderTimer, 1000);
  } catch (e) { showNotice(e.message, true); }
}
function durationText(seconds, compact = false) {
  seconds = Math.max(0, Math.floor(seconds));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  if (compact) {
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function getUserMs(userObj) {
  if (!userObj) return 0;
  let ms = Number(userObj.accumulatedMs || 0);
  if (userObj.active && userObj.startedAt) {
    const startTime = new Date(userObj.startedAt).getTime();
    if (!isNaN(startTime)) {
      const elapsed = Date.now() - startTime;
      if (elapsed > 0) ms += elapsed;
    }
  }
  return ms;
}
function getMyMs() {
  if (!state.room || !state.room.members || !state.user) return 0;
  const myId = String(state.user.id || state.user._id || "");
  const me = state.room.members.find(m => String(m.id || m._id || "") === myId);
  return getUserMs(me);
}
function getBuddyMs() {
  if (!state.room || !state.room.members || !state.user) return 0;
  const myId = String(state.user.id || state.user._id || "");
  const buddy = state.room.members.find(m => String(m.id || m._id || "") !== myId);
  return getUserMs(buddy);
}
function getSharedMs() {
  if (!state.room) return 0;
  let ms = Number(state.room.bothActiveAccumulatedMs || 0);
  if (state.room.bothActive && state.room.bothActiveStartedAt) {
    const startTime = new Date(state.room.bothActiveStartedAt).getTime();
    if (!isNaN(startTime)) {
      const elapsed = Date.now() - startTime;
      if (elapsed > 0) ms += elapsed;
    }
  }
  if (!ms && state.room.sharedTotalMs) ms = Number(state.room.sharedTotalMs);
  return ms;
}
function formatTime(dateVal) {
  if (!dateVal) return "Not started";
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return "Not started";
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function renderRoom() {
  if (!state.room) return;
  const r = state.room, members = r.members || [];
  const myId = String(state.user?.id || state.user?._id || "");
  const me = members.find(m => String(m.id || m._id || "") === myId);
  const buddy = members.find(m => String(m.id || m._id || "") !== myId);
  const isOwner = String(r.owner) === myId;
  const myActive = !!(me && me.active);
  const buddyActive = !!(buddy && buddy.active);
  const myStartCount = me ? (me.startCount || 0) : 0;
  const buddyStartCount = buddy ? (buddy.startCount || 0) : 0;
  const mySec = Math.floor(getMyMs() / 1000);
  const buddySec = Math.floor(getBuddyMs() / 1000);
  const sharedSec = Math.floor(getSharedMs() / 1000);

  $("#room-name").textContent = r.name; $("#room-code").textContent = r.code;
  $("#buddy-name").textContent = buddy ? buddy.name : "Your study buddy";
  $("#buddy-avatar").textContent = buddy ? buddy.name[0].toUpperCase() : "♡";

  $("#my-start-count").textContent = `▶ Started ${myStartCount} time${myStartCount === 1 ? "" : "s"}`;
  $("#buddy-start-count").textContent = buddy ? `▶ Started ${buddyStartCount} time${buddyStartCount === 1 ? "" : "s"}` : "▶ Waiting to join";

  const kickBtn = $("#kick-buddy-btn");
  if (kickBtn) {
    if (isOwner && buddy) {
      kickBtn.classList.remove("hidden");
      kickBtn.dataset.buddyId = buddy.id;
      kickBtn.dataset.buddyName = buddy.name;
    } else {
      kickBtn.classList.add("hidden");
    }
  }
  $("#start-btn").classList.toggle("hidden", myActive);
  $("#pause-btn").classList.toggle("hidden", !myActive);
  $("#finish-btn").classList.toggle("hidden", !mySec && !buddySec && !sharedSec && !myActive && !buddyActive);

  if (myActive && buddyActive) {
    $("#timer-label").textContent = "FOCUSING TOGETHER 🌿";
    $("#timer-hint").textContent = "Both timers are running! Shared water is filling the glass 🌊";
  } else if (myActive) {
    $("#timer-label").textContent = "MY TIMER RUNNING 🌱";
    $("#timer-hint").textContent = "Your timer is active. Waiting for buddy to start to fill the glass together 🌿";
  } else if (buddyActive) {
    $("#timer-label").textContent = "BUDDY STUDYING ⚡";
    $("#timer-hint").textContent = `${buddy ? buddy.name : "Buddy"}'s timer is active! Click Start timer to join them.`;
  } else {
    $("#timer-label").textContent = mySec > 0 ? "SESSION PAUSED" : "STOPPED";
    $("#timer-hint").textContent = "Click Start timer to begin focusing.";
  }
  renderTimer(); renderWater();
}
function renderTimer() {
  if (!state.room) return;
  const r = state.room, members = r.members || [];
  const myId = String(state.user?.id || state.user?._id || "");
  const me = members.find(m => String(m.id || m._id || "") === myId);
  const buddy = members.find(m => String(m.id || m._id || "") !== myId);

  const myMs = getMyMs();
  const mySec = Math.floor(myMs / 1000);
  $("#timer-display").textContent = durationText(mySec);

  const myActive = !!(me && me.active);
  const myPill = $("#my-pill");
  const myStatusChip = $("#my-status-chip");
  const myTimerTime = $("#my-timer-time");
  const myStartTime = $("#my-start-time");

  if (myActive) {
    if (myPill) { myPill.textContent = "Timer Started"; myPill.className = "status-pill live"; }
    if (myStatusChip) { myStatusChip.textContent = `🟢 Timer Started (${durationText(mySec, true)})`; myStatusChip.className = "timer-status-chip live"; }
    if (myTimerTime) myTimerTime.textContent = `⏱️ ${durationText(mySec)}`;
    if (myStartTime) myStartTime.textContent = `🕒 Started at ${formatTime(me.startedAt)}`;
  } else if (me && mySec > 0) {
    if (myPill) { myPill.textContent = "Timer Paused"; myPill.className = "status-pill paused"; }
    if (myStatusChip) { myStatusChip.textContent = `⏸️ Paused (${durationText(mySec, true)})`; myStatusChip.className = "timer-status-chip paused"; }
    if (myTimerTime) myTimerTime.textContent = `⏱️ ${durationText(mySec)} (Paused)`;
    if (myStartTime) myStartTime.textContent = `🕒 Last started at ${formatTime(me.lastStartedAt || me.startedAt)}`;
  } else {
    if (myPill) { myPill.textContent = "Timer Stopped"; myPill.className = "status-pill idle"; }
    if (myStatusChip) { myStatusChip.textContent = `⚪ Stopped (${durationText(mySec, true)})`; myStatusChip.className = "timer-status-chip idle"; }
    if (myTimerTime) myTimerTime.textContent = `⏱️ ${durationText(mySec)}`;
    if (myStartTime) myStartTime.textContent = me && me.lastStartedAt ? `🕒 Last started at ${formatTime(me.lastStartedAt)}` : "🕒 Not started";
  }

  // Buddy timer metrics
  const buddyMs = getBuddyMs();
  const buddySec = Math.floor(buddyMs / 1000);
  const buddyActive = !!(buddy && buddy.active);

  const buddyPill = $("#buddy-pill");
  const buddyStatusChip = $("#buddy-status-chip");
  const buddyTimerTime = $("#buddy-timer-time");
  const buddyStartTime = $("#buddy-start-time");

  if (buddy && buddyActive) {
    if (buddyPill) { buddyPill.textContent = "Timer Started"; buddyPill.className = "status-pill live"; }
    if (buddyStatusChip) { buddyStatusChip.textContent = `🟢 Timer Started (${durationText(buddySec, true)})`; buddyStatusChip.className = "timer-status-chip live"; }
    if (buddyTimerTime) buddyTimerTime.textContent = `⏱️ ${durationText(buddySec)}`;
    if (buddyStartTime) buddyStartTime.textContent = `🕒 Started at ${formatTime(buddy.startedAt)}`;
    $("#room-status").textContent = `🟢 ${buddy.name} is focusing (${durationText(buddySec, true)})`;
  } else if (buddy && buddySec > 0) {
    if (buddyPill) { buddyPill.textContent = "Timer Paused"; buddyPill.className = "status-pill paused"; }
    if (buddyStatusChip) { buddyStatusChip.textContent = `⏸️ Paused (${durationText(buddySec, true)})`; buddyStatusChip.className = "timer-status-chip paused"; }
    if (buddyTimerTime) buddyTimerTime.textContent = `⏱️ ${durationText(buddySec)} (Paused)`;
    if (buddyStartTime) buddyStartTime.textContent = `🕒 Last started at ${formatTime(buddy.lastStartedAt || buddy.startedAt)}`;
    $("#room-status").textContent = `⏸️ ${buddy.name}'s timer is paused (${durationText(buddySec, true)})`;
  } else if (buddy) {
    if (buddyPill) { buddyPill.textContent = "Timer Stopped"; buddyPill.className = "status-pill idle"; }
    if (buddyStatusChip) { buddyStatusChip.textContent = `⚪ Stopped (${durationText(buddySec, true)})`; buddyStatusChip.className = "timer-status-chip idle"; }
    if (buddyTimerTime) buddyTimerTime.textContent = `⏱️ ${durationText(buddySec)}`;
    if (buddyStartTime) buddyStartTime.textContent = buddy.lastStartedAt ? `🕒 Last started at ${formatTime(buddy.lastStartedAt)}` : "🕒 Not started";
    $("#room-status").textContent = `⚪ ${buddy.name}'s timer is stopped`;
  } else {
    if (buddyPill) { buddyPill.textContent = "Waiting"; buddyPill.className = "status-pill idle"; }
    if (buddyStatusChip) { buddyStatusChip.textContent = "⚪ Waiting to join"; buddyStatusChip.className = "timer-status-chip idle"; }
    if (buddyTimerTime) buddyTimerTime.textContent = "⏱️ 00:00:00";
    if (buddyStartTime) buddyStartTime.textContent = "🕒 Waiting to join";
    $("#room-status").textContent = "Waiting for your buddy";
  }
}
function renderWater() {
  const ms = getSharedMs(), mins = ms / 60000;
  const dailyGoal = state.room.dailyGoalMinutes || 120, weeklyGoal = state.room.weeklyGoalHours || 20;
  const dayPct = Math.min(100, mins / dailyGoal * 100);
  const weekMins = state.stats ? state.stats.weekSeconds / 60 : mins;
  const weekPct = Math.min(100, weekMins / (weeklyGoal * 60) * 100);
  const monthlyGoal = weeklyGoal * 60 * 4;
  const monthMins = state.stats ? state.stats.allSeconds / 60 : mins;
  const monthPct = Math.min(100, monthMins / monthlyGoal * 100);
  const glassPct = Math.min(100, dayPct);
  const height = 175 * glassPct / 100, y = 205 - height;
  $("#water-fill").setAttribute("y", y); $("#water-fill").setAttribute("height", height);
  $("#water-wave").setAttribute("d", `M 25 ${y+3} Q 48 ${y-5} 72 ${y+3} T 120 ${y+3} T 165 ${y+3} L 165 220 L 25 220 Z`);
  $("#glass-stage").textContent = dayPct >= 100 ? "DAILY GLASS COMPLETE ✨" : "THE DAILY GLASS";
  $("#water-percent").textContent = `${Math.round(glassPct)}%`;

  const me = state.room?.members?.find(m => m.id === state.user?.id);
  const buddy = state.room?.members?.find(m => m.id !== state.user?.id);
  const bothActive = me && me.active && buddy && buddy.active;

  if (dayPct >= 100) {
    $("#water-caption").textContent = "You showed up for your goal. Beautiful work!";
  } else if (bothActive) {
    $("#water-caption").textContent = `✨ Both timers active! ${Math.max(0, Math.ceil(dailyGoal - mins))} minutes left to fill today's glass.`;
  } else if (me && me.active) {
    $("#water-caption").textContent = `Your timer is active. Water fills when both you and ${buddy ? buddy.name : "your buddy"} study together.`;
  } else {
    $("#water-caption").textContent = `${Math.max(0, Math.ceil(dailyGoal - mins))} shared minutes to fill today's glass.`;
  }

  $("#today-time").textContent = durationText((state.stats?.todaySeconds || 0) + (ms / 1000), true);
  $("#week-time").textContent = durationText((state.stats?.weekSeconds || 0) + (ms / 1000), true);
  $("#all-time").textContent = durationText((state.stats?.allSeconds || 0) + (ms / 1000), true);
  $("#daily-progress").style.width = `${dayPct}%`; $("#daily-percent").textContent = `${Math.round(dayPct)}%`;
  $("#weekly-progress").style.width = `${weekPct}%`; $("#weekly-percent").textContent = `${Math.round(weekPct)}%`;
  $("#monthly-progress").style.width = `${monthPct}%`; $("#monthly-percent").textContent = `${Math.round(monthPct)}%`;
  $("#daily-milestone-text").textContent = `${Math.round(mins)} of ${dailyGoal} shared minutes`;
  $("#weekly-milestone-text").textContent = `${Math.round(weekMins/60*10)/10} of ${weeklyGoal} shared hours`;
  $("#monthly-milestone-text").textContent = `${Math.round(monthMins/60*10)/10} of ${weeklyGoal*4} shared hours`;
}
async function refreshStats() {
  if (!state.room) return;
  try { state.stats = await api(`/api/rooms/${state.room.code}/stats`); renderWater(); renderHistory(); } catch {}
}
function renderHistory() {
  const el = $("#session-history"); const sessions = state.stats?.recentSessions || [];
  if (!sessions.length) { el.innerHTML = '<div class="empty-history">Your completed focus sessions will bloom here. 🌷</div>'; return; }
  el.innerHTML = "";
  sessions.forEach(s => {
    const row = document.createElement("div"); row.className = "history-item";
    const date = document.createElement("span"); date.textContent = s.endedAt ? new Date(s.endedAt).toLocaleString() : "Completed session";
    const duration = document.createElement("strong"); duration.textContent = durationText(s.durationSeconds, true);
    row.append(date, duration); el.append(row);
  });
}
async function timerAction(action) {
  if (!state.room) return;
  try {
    const { room } = await api(`/api/rooms/${state.room.code}/timer`, { method: "POST", body: JSON.stringify({ action }) });
    state.room = room; renderRoom();
    if (action === "finish") { await refreshStats(); toast("Session saved. Every little bit counts 🌷"); }
    else toast(action === "start" ? "Your timer started 🌱" : "Your timer paused.");
  } catch (e) { toast(e.message, true); }
}
$("#start-btn").addEventListener("click", () => timerAction("start"));
$("#pause-btn").addEventListener("click", () => timerAction("pause"));
$("#finish-btn").addEventListener("click", () => {
  if (confirm("Finish and save this shared session?")) timerAction("finish");
});
const kickBtn = $("#kick-buddy-btn");
if (kickBtn) {
  kickBtn.addEventListener("click", async () => {
    const buddyId = kickBtn.dataset.buddyId;
    const buddyName = kickBtn.dataset.buddyName || "member";
    if (!buddyId || !state.room) return;
    if (confirm(`Remove ${buddyName} from this room?`)) {
      try {
        const { room } = await api(`/api/rooms/${state.room.code}/members/${buddyId}`, { method: "DELETE" });
        state.room = room; renderRoom();
        toast(`${buddyName} was removed from the room.`);
      } catch (err) { toast(err.message, true); }
    }
  });
}
$("#settings-form").addEventListener("submit", async e => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.currentTarget).entries());
  try {
    const { room } = await api(`/api/rooms/${state.room.code}/settings`, { method: "POST", body: JSON.stringify(form) });
    state.room = room; renderRoom(); toast("Your garden goals have been saved 🌿");
  } catch (err) { toast(err.message, true); }
});
setInterval(() => { if (state.room) { renderTimer(); renderWater(); } }, 1000);
if (state.token) loadDashboard(); else showAuth();
