const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json({ limit: "32kb" }));
app.use(express.static("public", { extensions: ["html"] }));

const configuredPin = process.env.CAMERA_PIN;
if (!configuredPin || configuredPin.length < 6) {
  console.warn("WARNING: Set CAMERA_PIN (at least 6 characters) in Render Environment.");
}

function pinOk(value) {
  if (!configuredPin || typeof value !== "string") return false;
  const a = Buffer.from(value);
  const b = Buffer.from(configuredPin);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function validId(value) {
  return typeof value === "string" && /^[a-f0-9-]{20,40}$/i.test(value);
}
function auth(req, res, next) {
  if (!pinOk(req.get("x-camera-pin"))) return res.status(401).json({ error: "Неправильний PIN-код." });
  next();
}

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL is missing. Device list cannot be stored persistently.");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS camera_devices (
      device_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
app.get("/api/health", async (_req, res) => {
  res.json({ ok: true, database: Boolean(process.env.DATABASE_URL) });
});
app.get("/api/devices", auth, async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT device_id AS id, name, last_seen FROM camera_devices ORDER BY last_seen DESC"
    );
    res.json({ devices: result.rows });
  } catch (error) {
    console.error(error);
    res.status(503).json({ error: "База даних не налаштована. Перевір DATABASE_URL у Render." });
  }
});
app.post("/api/devices", auth, async (req, res) => {
  const { id, name } = req.body || {};
  if (!validId(id) || typeof name !== "string" || !name.trim() || name.trim().length > 40) {
    return res.status(400).json({ error: "Перевір назву та ідентифікатор пристрою." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO camera_devices(device_id, name, last_seen)
       VALUES($1, $2, NOW())
       ON CONFLICT(device_id) DO UPDATE SET name = EXCLUDED.name, last_seen = NOW()
       RETURNING device_id AS id, name, last_seen`,
      [id, name.trim()]
    );
    res.json({ device: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(503).json({ error: "Не вдалося зберегти пристрій. Перевір базу даних Render." });
  }
});
app.patch("/api/devices/:id", auth, async (req, res) => {
  const { name } = req.body || {};
  if (!validId(req.params.id) || typeof name !== "string" || !name.trim() || name.trim().length > 40)
    return res.status(400).json({ error: "Некоректна назва пристрою." });
  try {
    const result = await pool.query(
      "UPDATE camera_devices SET name=$2 WHERE device_id=$1 RETURNING device_id AS id, name, last_seen",
      [req.params.id, name.trim()]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Пристрій не знайдено." });
    res.json({ device: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(503).json({ error: "Помилка бази даних." });
  }
});
app.delete("/api/devices/:id", auth, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: "Некоректний пристрій." });
  try {
    await pool.query("DELETE FROM camera_devices WHERE device_id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(503).json({ error: "Помилка бази даних." });
  }
});

app.get("/turn-credentials", (req, res) => {
  const username = process.env.TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL;
  if (!username || !credential) return res.status(503).json({ error: "TURN credentials are not configured." });
  res.setHeader("Cache-Control", "no-store");
  res.json({ username, credential });
});

const rooms = new Map();
function validRoom(value) {
  return typeof value === "string" && /^cam_[a-f0-9-]{20,40}$/i.test(value);
}
io.on("connection", socket => {
  socket.on("join", ({ room, role, pin } = {}, reply = () => {}) => {
    if (!pinOk(pin)) return reply({ ok: false, error: "Неправильний PIN-код." });
    if (!validRoom(room) || !["sender", "viewer"].includes(role))
      return reply({ ok: false, error: "Некоректне підключення." });
    let state = rooms.get(room);
    if (!state) state = { sender: null, viewer: null };
    if (state[role] && state[role] !== socket.id)
      return reply({ ok: false, error: "Цей телефон уже підключений з іншого пристрою." });
    leaveRoom(socket);
    state = rooms.get(room) || { sender: null, viewer: null };
    if (state[role] && state[role] !== socket.id)
      return reply({ ok: false, error: "Ця роль уже зайнята." });
    state[role] = socket.id;
    rooms.set(room, state);
    socket.data.room = room;
    socket.data.role = role;
    socket.join(room);
    reply({ ok: true });
    if (role === "viewer" && state.sender) io.to(state.sender).emit("viewer-ready");
    if (role === "sender" && state.viewer) socket.emit("viewer-ready");
  });
  socket.on("signal", ({ room, data } = {}) => {
    if (!validRoom(room) || room !== socket.data.room || !data) return;
    const state = rooms.get(room);
    if (!state) return;
    const peer = socket.data.role === "sender" ? state.viewer : state.sender;
    if (peer) io.to(peer).emit("signal", data);
  });
  socket.on("leave", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket));
});
function leaveRoom(socket) {
  const { room, role } = socket.data || {};
  if (!room || !role) return;
  const state = rooms.get(room);
  if (state && state[role] === socket.id) {
    state[role] = null;
    const peer = role === "sender" ? state.viewer : state.sender;
    if (peer) io.to(peer).emit("peer-left");
    if (!state.sender && !state.viewer) rooms.delete(room);
  }
  socket.leave(room);
  socket.data.room = null;
  socket.data.role = null;
}

const port = Number(process.env.PORT || 3000);
initDb().then(() => server.listen(port, "0.0.0.0", () => {
  console.log(`Camera Link server listening on ${port}`);
})).catch(error => {
  console.error("Database initialization failed:", error);
  process.exit(1);
});
        
