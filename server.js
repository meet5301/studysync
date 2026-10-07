const dns = require("node:dns");

dns.setServers(["1.1.1.1", "8.8.8.8"]);
require("dotenv").config();
const path = require("path");
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!process.env.MONGODB_URI || !JWT_SECRET) {
  console.error("Missing MONGODB_URI or JWT_SECRET. Copy .env.example to .env and configure it.");
  process.exit(1);
}

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 32 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const roomSchema = new mongoose.Schema({
  code: { type: String, unique: true, index: true },
  name: { type: String, default: "Our little study garden" },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  statuses: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    active: { type: Boolean, default: false },
    startedAt: { type: Date, default: null },
    startCount: { type: Number, default: 0 },
    accumulatedMs: { type: Number, default: 0 }
  }],
  createdAt: { type: Date, default: Date.now },
  activeStartedAt: { type: Date, default: null },
  accumulatedMs: { type: Number, default: 0 },
  isRunning: { type: Boolean, default: false },
  dailyGoalMinutes: { type: Number, default: 120 },
  weeklyGoalHours: { type: Number, default: 20 },
  events: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    type: { type: String },
    at: { type: Date, default: Date.now }
  }]
}, { minimize: false });

const sessionSchema = new mongoose.Schema({
  room: { type: mongoose.Schema.Types.ObjectId, ref: "Room", required: true, index: true },
  startedAt: { type: Date, required: true },
  endedAt: { type: Date, default: null },
  durationSeconds: { type: Number, default: 0 },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }]
}, { timestamps: true });

const User = mongoose.model("User", userSchema);
const Room = mongoose.model("Room", roomSchema);
const StudySession = mongoose.model("StudySession", sessionSchema);

function tokenFor(user) {
  return jwt.sign({ id: String(user._id), name: user.name }, JWT_SECRET, { expiresIn: "14d" });
}
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    if (!token) throw new Error("Missing token");
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Please sign in again." });
  }
}
function safeUser(user) {
  return { id: String(user._id), name: user.name, email: user.email };
}
function roomPayload(room, userNames = []) {
  const runningMs = room.isRunning && room.activeStartedAt
    ? Date.now() - new Date(room.activeStartedAt).getTime() : 0;
  const totalMs = Math.max(0, (room.accumulatedMs || 0) + runningMs);
  const statuses = Array.isArray(room.statuses) ? room.statuses : [];
  return {
    id: String(room._id), code: room.code, name: room.name,
    owner: room.owner ? String(room.owner) : "",
    memberCount: (room.members || []).length,
    members: userNames.map(u => {
      const s = statuses.find(st => st && st.userId && String(st.userId) === u.id);
      return {
        ...u,
        active: !!(s && s.active),
        startedAt: s && s.startedAt ? s.startedAt : null,
        startCount: s && s.startCount ? s.startCount : 0,
        accumulatedMs: s && s.accumulatedMs ? s.accumulatedMs : 0
      };
    }),
    isRunning: !!room.isRunning,
    accumulatedMs: room.accumulatedMs || 0,
    totalMs,
    activeStartedAt: room.activeStartedAt,
    dailyGoalMinutes: room.dailyGoalMinutes || 120,
    weeklyGoalHours: room.weeklyGoalHours || 20,
    createdAt: room.createdAt
  };
}
async function getRoomForUser(code, userId) {
  const cleanCode = String(code || "").trim().toUpperCase();
  const room = await Room.findOne({ code: cleanCode });
  if (!room) return { error: "Room code not found." };
  if (!room.members || !room.members.some(m => m && String(m) === String(userId))) {
    return { error: "You are not a member of this room." };
  }
  return { room };
}
async function memberNames(room) {
  if (!room.members || !room.members.length) return [];
  const users = await User.find({ _id: { $in: room.members } }).select("name");
  return users.map(u => ({ id: String(u._id), name: u.name }));
}
async function broadcastRoom(room) {
  const names = await memberNames(room);
  io.to(`room:${room.code}`).emit("room:update", roomPayload(room, names));
}
async function totalRoomMs(room) {
  return Math.max(0, (room.accumulatedMs || 0) + (room.isRunning && room.activeStartedAt ? Date.now() - new Date(room.activeStartedAt).getTime() : 0));
}
async function persistRunningTime(room) {
  if (room.isRunning && room.activeStartedAt) {
    room.accumulatedMs = (room.accumulatedMs || 0) + Math.max(0, Date.now() - new Date(room.activeStartedAt).getTime());
    room.activeStartedAt = new Date();
  }
}
function generateCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (name.length < 2 || name.length > 32) return res.status(400).json({ error: "Name must be 2–32 characters." });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ name, email, passwordHash });
    res.json({ token: tokenFor(user), user: safeUser(user) });
  } catch (e) {
    res.status(e.code === 11000 ? 409 : 500).json({ error: e.code === 11000 ? "That email is already registered." : "Could not create account." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: "Email or password is incorrect." });
    res.json({ token: tokenFor(user), user: safeUser(user) });
  } catch {
    res.status(500).json({ error: "Could not sign in." });
  }
});

app.get("/api/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("name email");
    if (!user) return res.status(404).json({ error: "Account not found." });
    const rooms = await Room.find({ members: user._id }).sort({ createdAt: -1 }).limit(20);
    const result = [];
    for (const room of rooms) result.push(roomPayload(room, await memberNames(room)));
    res.json({ user: safeUser(user), rooms: result });
  } catch (err) {
    console.error("api/me error:", err);
    res.status(500).json({ error: "Could not fetch user data." });
  }
});

app.post("/api/rooms", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    let code;
    for (let i = 0; i < 8; i++) {
      code = generateCode();
      if (!(await Room.exists({ code }))) break;
    }
    const room = await Room.create({
      code, name: String(req.body.name || "Our little study garden").trim().slice(0, 60),
      owner: user._id, members: [user._id], statuses: [{ userId: user._id, active: false, startedAt: null, startCount: 0, accumulatedMs: 0 }],
      dailyGoalMinutes: Math.min(720, Math.max(15, Number(req.body.dailyGoalMinutes) || 120)),
      weeklyGoalHours: Math.min(100, Math.max(1, Number(req.body.weeklyGoalHours) || 20))
    });
    res.json({ room: roomPayload(room, await memberNames(room)) });
  } catch (err) {
    console.error("Create room error:", err);
    res.status(500).json({ error: "Could not create a room." });
  }
});

app.post("/api/rooms/join", auth, async (req, res) => {
  try {
    const code = String(req.body.code || "").trim().toUpperCase();
    if (!/^[A-F0-9]{8}$/.test(code)) return res.status(400).json({ error: "Enter the 8-character room code." });
    const room = await Room.findOne({ code });
    if (!room) return res.status(404).json({ error: "Room not found. Check the code and try again." });
    if (!Array.isArray(room.members)) room.members = [];
    if (!Array.isArray(room.statuses)) room.statuses = [];

    const already = room.members.some(m => m && String(m) === String(req.user.id));
    if (!already && room.members.length >= 2) return res.status(400).json({ error: "This room is full (2 members maximum)." });
    if (!already) {
      room.members.push(req.user.id);
      room.statuses.push({ userId: req.user.id, active: false, startedAt: null, startCount: 0, accumulatedMs: 0 });
    }
    await room.save();
    res.json({ room: roomPayload(room, await memberNames(room)) });
    await broadcastRoom(room);
  } catch (err) {
    console.error("Join room error:", err);
    res.status(500).json({ error: "Could not join room." });
  }
});

app.get("/api/rooms/:code", auth, async (req, res) => {
  const result = await getRoomForUser(req.params.code, req.user.id);
  if (result.error) return res.status(404).json({ error: result.error });
  res.json({ room: roomPayload(result.room, await memberNames(result.room)) });
});

app.post("/api/rooms/:code/timer", auth, async (req, res) => {
  try {
    const result = await getRoomForUser(req.params.code, req.user.id);
    if (result.error) return res.status(403).json({ error: result.error });
    const room = result.room;
    const action = String(req.body.action || "");
    if (!Array.isArray(room.statuses)) room.statuses = [];
    if (!Array.isArray(room.events)) room.events = [];
    if (!Array.isArray(room.members)) room.members = [];

    if (action === "start") {
      let status = room.statuses.find(s => s && s.userId && String(s.userId) === String(req.user.id));
      if (!status) {
        status = { userId: req.user.id, active: true, startedAt: new Date(), startCount: 1, accumulatedMs: 0 };
        room.statuses.push(status);
      } else {
        status.active = true;
        status.startedAt = new Date();
        status.startCount = (status.startCount || 0) + 1;
      }
      room.events.push({ userId: req.user.id, type: "start", at: new Date() });
      if (!room.isRunning) {
        room.isRunning = true;
        room.activeStartedAt = new Date();
      }
    } else if (action === "pause") {
      let status = room.statuses.find(s => s && s.userId && String(s.userId) === String(req.user.id));
      if (status && status.active) {
        if (status.startedAt) {
          const elapsed = Date.now() - new Date(status.startedAt).getTime();
          status.accumulatedMs = (status.accumulatedMs || 0) + Math.max(0, elapsed);
        }
        status.active = false;
        status.startedAt = null;
      }
      const anyActive = room.statuses.some(s => s && s.active);
      if (!anyActive && room.isRunning) {
        await persistRunningTime(room);
        room.isRunning = false;
        room.activeStartedAt = null;
      }
      room.events.push({ userId: req.user.id, type: "pause", at: new Date() });
    } else if (action === "finish") {
      if (room.isRunning) await persistRunningTime(room);
      const duration = Math.floor((room.accumulatedMs || 0) / 1000);
      if (duration > 0) {
        await StudySession.create({ room: room._id, startedAt: new Date(Date.now() - duration * 1000), endedAt: new Date(), durationSeconds: duration, members: room.members });
      }
      room.accumulatedMs = 0;
      room.activeStartedAt = null;
      room.isRunning = false;
      room.statuses.forEach(s => {
        if (s) {
          s.active = false;
          s.startedAt = null;
          s.accumulatedMs = 0;
          s.startCount = 0;
        }
      });
      room.events.push({ userId: req.user.id, type: "finish", at: new Date() });
    } else {
      return res.status(400).json({ error: "Unknown timer action." });
    }
    await room.save();
    await broadcastRoom(room);
    res.json({ room: roomPayload(room, await memberNames(room)) });
  } catch (err) {
    console.error("Timer action error:", err);
    res.status(500).json({ error: err.message || "Timer action failed." });
  }
});

app.delete("/api/rooms/:code/members/:targetUserId", auth, async (req, res) => {
  try {
    const result = await getRoomForUser(req.params.code, req.user.id);
    if (result.error) return res.status(403).json({ error: result.error });
    const room = result.room;
    if (String(room.owner) !== String(req.user.id)) {
      return res.status(403).json({ error: "Only the room creator can delete members." });
    }
    const targetUserId = String(req.params.targetUserId);
    if (targetUserId === String(req.user.id)) {
      return res.status(400).json({ error: "You cannot delete yourself from your room." });
    }
    if (!room.members || !room.members.some(m => m && String(m) === targetUserId)) {
      return res.status(404).json({ error: "Member not found in this room." });
    }
    room.members = room.members.filter(m => m && String(m) !== targetUserId);
    room.statuses = (room.statuses || []).filter(s => s && s.userId && String(s.userId) !== targetUserId);
    if (room.isRunning) {
      await persistRunningTime(room);
    }
    await room.save();
    await broadcastRoom(room);
    res.json({ room: roomPayload(room, await memberNames(room)) });
  } catch (err) {
    console.error("Delete member error:", err);
    res.status(500).json({ error: err.message || "Could not remove member." });
  }
});

app.get("/api/rooms/:code/stats", auth, async (req, res) => {
  const result = await getRoomForUser(req.params.code, req.user.id);
  if (result.error) return res.status(403).json({ error: result.error });
  const room = result.room;
  const sessions = await StudySession.find({ room: room._id }).sort({ endedAt: -1 }).limit(100);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startWeek = new Date(today);
  startWeek.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  let todaySeconds = 0, weekSeconds = 0, allSeconds = 0;
  sessions.forEach(s => {
    const end = s.endedAt || s.createdAt;
    allSeconds += s.durationSeconds;
    if (end >= today) todaySeconds += s.durationSeconds;
    if (end >= startWeek) weekSeconds += s.durationSeconds;
  });
  const currentMs = await totalRoomMs(room);
  res.json({
    todaySeconds: todaySeconds + Math.min(currentMs / 1000, 86400),
    weekSeconds: weekSeconds + currentMs / 1000,
    allSeconds: allSeconds + currentMs / 1000,
    recentSessions: sessions.slice(0, 8).map(s => ({ endedAt: s.endedAt, durationSeconds: s.durationSeconds }))
  });
});

app.post("/api/rooms/:code/settings", auth, async (req, res) => {
  const result = await getRoomForUser(req.params.code, req.user.id);
  if (result.error) return res.status(403).json({ error: result.error });
  const room = result.room;
  if (String(room.owner) !== String(req.user.id)) return res.status(403).json({ error: "Only the room creator can change goals." });
  room.dailyGoalMinutes = Math.min(720, Math.max(15, Number(req.body.dailyGoalMinutes) || 120));
  room.weeklyGoalHours = Math.min(100, Math.max(1, Number(req.body.weeklyGoalHours) || 20));
  await room.save();
  await broadcastRoom(room);
  res.json({ room: roomPayload(room, await memberNames(room)) });
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication required"));
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { next(new Error("Invalid session")); }
});
io.on("connection", socket => {
  socket.on("room:join", async code => {
    try {
      const result = await getRoomForUser(code, socket.user.id);
      if (result.error) return socket.emit("app:error", result.error);
      socket.join(`room:${result.room.code}`);
      socket.emit("room:update", roomPayload(result.room, await memberNames(result.room)));
      socket.to(`room:${result.room.code}`).emit("room:presence", { name: socket.user.name, status: "joined" });
    } catch {}
  });
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 12000 })
  .then(() => server.listen(PORT, () => console.log(`StudySync running at http://localhost:${PORT}`)))
  .catch(err => {
    console.error("MongoDB connection failed. Check MONGODB_URI, Atlas database user and Network Access.");
    console.error(err.message);
    process.exit(1);
  });
