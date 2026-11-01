const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.static("public", { extensions: ["html"] }));

// TURN credentials are stored in Render Environment, not in the GitHub file.
app.get("/turn-credentials", (req, res) => {
  const username = process.env.TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL;

  if (!username || !credential) {
    return res.status(503).json({ error: "TURN credentials are not configured on the server." });
  }

  res.setHeader("Cache-Control", "no-store");
  res.json({ username, credential });
});

const rooms = new Map();

function validRoom(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{4,32}$/.test(value);
}

io.on("connection", (socket) => {
  socket.on("join", ({ room, role } = {}, reply = () => {}) => {
    if (!validRoom(room) || !["sender", "viewer"].includes(role)) {
      return reply({ ok: false, error: "Код кімнати має містити 4–32 латинські літери, цифри, _ або -." });
    }

    let state = rooms.get(room);
    if (!state) {
      state = { sender: null, viewer: null };
      rooms.set(room, state);
    }

    if (state[role] && state[role] !== socket.id) {
      return reply({ ok: false, error: `У цій кімнаті вже є ${role === "sender" ? "передавач" : "глядач"}.` });
    }

    // If this socket was already in another room, clean it up first.
    leaveRoom(socket);

    state = rooms.get(room) || { sender: null, viewer: null };
    rooms.set(room, state);
    if (state[role] && state[role] !== socket.id) {
      return reply({ ok: false, error: "Ця роль уже зайнята в кімнаті." });
    }

    state[role] = socket.id;
    socket.data.room = room;
    socket.data.role = role;
    socket.join(room);
    reply({ ok: true });

    if (role === "viewer" && state.sender) io.to(state.sender).emit("viewer-ready");
    if (role === "sender" && state.viewer) socket.emit("viewer-ready");
  });

  socket.on("signal", (message = {}) => {
    const { room, data } = message;
    if (!validRoom(room) || room !== socket.data.room || !data) return;
    const state = rooms.get(room);
    if (!state) return;
    const peerId = socket.data.role === "sender" ? state.viewer : state.sender;
    if (peerId) io.to(peerId).emit("signal", data);
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
    const peerId = role === "sender" ? state.viewer : state.sender;
    if (peerId) io.to(peerId).emit("peer-left");
    if (!state.sender && !state.viewer) rooms.delete(room);
  }

  socket.leave(room);
  socket.data.room = null;
  socket.data.role = null;
}

const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0", () => {
  console.log(`Camera signaling server listening on port ${port}`);
});
