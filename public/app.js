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
  if (compact) return h ? `${h}h ${m}m` : `${m}m`;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function currentMs() {
  if (!state.room) return 0;
  let ms = Number(state.room.accumulatedMs || 0);
  if (state.room.isRunning && state.room.activeStartedAt) {
    const elapsed = Date.now() - new Date(state.room.activeStartedAt).getTime();
    if (elapsed > 0) ms += elapsed;
  }
  return ms;
}
function renderRoom() {
  if (!state.room) return;
  const r = state.room, members = r.members || [];
  const buddy = members.find(m => m.id !== state.user.id);
  const isOwner = String(r.owner) === String(state.user.id);
  $("#room-name").textContent = r.name; $("#room-code").textContent = r.code;
  $("#room-status").textContent = r.isRunning ? "Shared focus is growing" : (buddy ? "Ready when you both are" : "Invite your buddy to begin");
  $("#buddy-name").textContent = buddy ? buddy.name : "Your study buddy";
  $("#buddy-avatar").textContent = buddy ? buddy.name[0].toUpperCase() : "♡";
  const meStatus = members.find(m => m.id === state.user.id);
  const buddyActive = !!(buddy && buddy.active);
  const myActive = !!(meStatus && meStatus.active);
  $("#buddy-state").textContent = buddy ? (buddyActive ? (r.isRunning ? "Focusing with you" : "Ready — waiting for you") : "Not studying right now") : "Waiting to join";
  $("#my-state").textContent = myActive ? (r.isRunning ? "Focus session in progress" : "Ready — waiting for your buddy") : "Ready when you are";
  $("#my-pill").textContent = myActive ? (r.isRunning ? "Focusing" : "Ready") : "Not started";
  $("#my-pill").className = "status-pill " + (r.isRunning && myActive ? "live" : (myActive ? "paused" : "idle"));
  $("#buddy-pill").textContent = buddy ? (buddyActive ? (r.isRunning ? "Focusing" : "Ready") : "Not started") : "Waiting";
  $("#buddy-pill").className = "status-pill " + (r.isRunning && buddyActive ? "live" : (buddyActive ? "paused" : "idle"));
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
  $("#finish-btn").classList.toggle("hidden", !r.totalMs && !r.isRunning);
  $("#timer-label").textContent = r.isRunning ? "GROWING TOGETHER" : (myActive || (buddy && buddyActive) ? "WAITING FOR BOTH" : (r.totalMs ? "SESSION PAUSED" : "READY TO FOCUS"));
  $("#timer-hint").textContent = r.isRunning ? "Lovely work. Your shared water is growing." : (myActive || (buddy && buddyActive) ? "The water starts when everyone in this room is ready." : "You both need to start for shared progress to grow.");
  renderTimer(); renderWater();
}
function renderTimer() { if (state.room) $("#timer-display").textContent = durationText(currentMs()/1000); }
function renderWater() {
  const ms = currentMs(), mins = ms / 60000;
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
  $("#water-caption").textContent = dayPct >= 100 ? "You showed up for your goal. Beautiful work!" : `${Math.max(0, Math.ceil(dailyGoal-mins))} shared minutes to fill today's glass.`;
  $("#today-time").textContent = durationText((state.stats?.todaySeconds || 0), true);
  $("#week-time").textContent = durationText((state.stats?.weekSeconds || 0), true);
  $("#all-time").textContent = durationText((state.stats?.allSeconds || 0), true);
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
    else toast(action === "start" ? "Let's focus together 🌱" : "Timer paused. Take a gentle break.");
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
setInterval(() => { if (state.room && state.room.isRunning) { renderTimer(); renderWater(); } }, 1000);
if (state.token) loadDashboard(); else showAuth();
