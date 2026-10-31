const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 1e6
});

app.use(express.static("public", { extensions: ["html"] }));

// Signaling only: video/audio media travels peer-to-peer when the networks allow it.
const rooms = new Map();

function validRoom(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{4,32}$/.test(value);
}

io.on("connection", (socket) => {
  socket.on("join", ({ room, role } = {}, reply = () => {}) => {
    if (!validRoom(room) || !["sender", "viewer"].includes(role)) {
      return reply({ ok: false, error: "Use a 4–32 character room code (letters/numbers)." });
    }

    let state = rooms.get(room);
    if (!state) {
      state = { sender: null, viewer: null };
      rooms.set(room, state);
    }

    if (state[role] && state[role] !== socket.id) {
      return reply({ ok: false, error: `A ${role} is already in this room.` });
    }

    state[role] = socket.id;
    socket.data.room = room;
    socket.data.role = role;
    socket.join(room);
    reply({ ok: true });

    if (role === "viewer" && state.sender) {
      io.to(state.sender).emit("viewer-ready");
    }
    if (role === "sender" && state.viewer) {
      socket.emit("viewer-ready");
    }
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
  const { room, role } = socket.data;
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