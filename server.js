"use strict";
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

// ── HOST-BASED ROUTING ────────────────────────────────────────────────────────
// CNAME records can only point to a hostname, not a path, so we do path routing
// here in express based on the incoming Host header.
//
//   watch.skybound.at     → CNAME → summerday.onrender.com  → serves /client
//   broadcast.skybound.at → CNAME → summerday.onrender.com  → serves /broadcaster
//   admin.skybound.at     → CNAME → summerday.onrender.com  → serves /admin
//
// The user sets three CNAME records all pointing to summerday.onrender.com,
// and this middleware does the rest.

function hostRouter(req, res, next) {
  const host = (req.hostname || "").toLowerCase();
  if (host === "watch.skybound.at") {
    // Rewrite request path so static middleware below serves /client/*
    req.url = "/client" + (req.url === "/" ? "/" : req.url);
  } else if (host === "broadcast.skybound.at") {
    req.url = "/broadcaster" + (req.url === "/" ? "/" : req.url);
  } else if (host === "admin.skybound.at") {
    req.url = "/admin" + (req.url === "/" ? "/" : req.url);
  }
  next();
}

app.use(hostRouter);

// ── STATIC FILES ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use("/broadcaster", express.static(path.join(__dirname, "public", "broadcaster")));
app.use("/client",      express.static(path.join(__dirname, "public", "client")));
app.use("/admin",       express.static(path.join(__dirname, "public", "admin")));

// Explicit index routes (catches bare /broadcaster etc. without trailing slash)
app.get("/broadcaster", (req, res) => res.sendFile(path.join(__dirname, "public", "broadcaster", "index.html")));
app.get("/client",      (req, res) => res.sendFile(path.join(__dirname, "public", "client",      "index.html")));
app.get("/admin",       (req, res) => res.sendFile(path.join(__dirname, "public", "admin",       "index.html")));

// ── STATE ─────────────────────────────────────────────────────────────────────
const channelBroadcasters = new Map();   // channelId → broadcasterSocketId
const broadcasterChannels = new Map();   // broadcasterSocketId → channelId
const viewerChannels      = new Map();   // viewerSocketId → channelId
const adminSockets        = new Set();   // authenticated admin socket ids
const channelThumbnails   = new Map();   // channelId → latest snapshot dataURL (Station Content Preview)

const ADMIN_PASSWORD = "skybound2025";

function listLiveChannels() { return Array.from(channelBroadcasters.keys()); }

function notifyAdmins(event, payload) {
  adminSockets.forEach(id => io.to(id).emit(event, payload));
}

// ── SOCKET.IO ─────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  socket.emit("channels-updated", listLiveChannels());
  // Send whatever Station Content Preview snapshots we already have so a
  // freshly-connected client sees content for stations that were already
  // live before this client showed up — not just an empty placeholder.
  channelThumbnails.forEach((dataUrl, id) => {
    if (channelBroadcasters.has(id)) socket.emit("channel-thumbnail", { channelId: id, dataUrl });
  });

  // ── BROADCASTER ─────────────────────────────────────────────────────────────
  socket.on("broadcaster-register", (channelId, ack) => {
    const id = String(channelId || "").trim().slice(0, 64) || "canal-1";
    if (channelBroadcasters.has(id) && channelBroadcasters.get(id) !== socket.id) {
      if (typeof ack === "function") ack({ ok: false, error: "Canal já está no ar." });
      return;
    }
    channelBroadcasters.set(id, socket.id);
    broadcasterChannels.set(socket.id, id);
    socket.join(`broadcaster:${id}`);
    io.emit("channels-updated", listLiveChannels());
    notifyAdmins("admin:channels-updated", listLiveChannels());
    if (typeof ack === "function") ack({ ok: true, channelId: id });
  });

  socket.on("broadcaster-unregister", () => {
    const ch = broadcasterChannels.get(socket.id);
    if (ch) {
      channelBroadcasters.delete(ch);
      broadcasterChannels.delete(socket.id);
      channelThumbnails.delete(ch);
      io.emit("channels-updated", listLiveChannels());
      notifyAdmins("admin:channels-updated", listLiveChannels());
      io.to(`viewers:${ch}`).emit("broadcaster-left");
    }
  });

  // Station Content Preview: broadcaster periodically pushes a small
  // snapshot of its output canvas; we relay it to everyone so the client's
  // preview grid shows real content instead of a static placeholder.
  socket.on("broadcaster-thumbnail", ({ channelId, dataUrl } = {}) => {
    const ch = broadcasterChannels.get(socket.id);
    if (!ch || ch !== channelId || !dataUrl) return; // only the registered owner may update it
    channelThumbnails.set(ch, dataUrl);
    io.emit("channel-thumbnail", { channelId: ch, dataUrl });
  });

  // ── VIEWER ──────────────────────────────────────────────────────────────────
  socket.on("viewer-join", (channelId) => {
    const id = String(channelId || "").trim();
    const bcId = channelBroadcasters.get(id);
    if (!bcId) { socket.emit("viewer-error", { message: "Canal indisponível" }); return; }
    socket.join(`viewers:${id}`);
    viewerChannels.set(socket.id, id);
    io.to(bcId).emit("viewer-ready", { viewerId: socket.id, channelId: id });
  });

  socket.on("viewer-leave", (channelId) => {
    const id = String(channelId || "").trim();
    socket.leave(`viewers:${id}`);
    viewerChannels.delete(socket.id);
    const bcId = channelBroadcasters.get(id);
    if (bcId) io.to(bcId).emit("viewer-gone", { viewerId: socket.id });
  });

  socket.on("signal", ({ to, data }) => {
    if (!to || !data) return;
    io.to(to).emit("signal", { from: socket.id, data });
  });

  // ── ADMIN ───────────────────────────────────────────────────────────────────
  socket.on("admin:auth", (password, ack) => {
    if (password === ADMIN_PASSWORD) {
      adminSockets.add(socket.id);
      socket.join("admins");
      if (typeof ack === "function") ack({ ok: true, channels: listLiveChannels() });
    } else {
      if (typeof ack === "function") ack({ ok: false, error: "Wrong password." });
    }
  });

  // Admin pushes a command to all viewers of a channel (or all channels)
  // cmd: { type: "toast"|"image"|"video"|"audio"|"takedown", channelId: "all"|"<id>", ...payload }
  socket.on("admin:push", (cmd) => {
    if (!adminSockets.has(socket.id)) return; // silently reject unauthenticated
    const { channelId, ...payload } = cmd;
    if (channelId === "all") {
      io.emit("admin:command", payload);
    } else {
      io.to(`viewers:${channelId}`).emit("admin:command", payload);
      // Also send to broadcaster so they see it too
      const bcId = channelBroadcasters.get(channelId);
      if (bcId) io.to(bcId).emit("admin:command", payload);
    }
  });

  // Admin takes a channel off-air (kicks the broadcaster)
  socket.on("admin:takedown", (channelId, ack) => {
    if (!adminSockets.has(socket.id)) { if (typeof ack === "function") ack({ ok: false }); return; }
    const bcId = channelBroadcasters.get(channelId);
    if (!bcId) { if (typeof ack === "function") ack({ ok: false, error: "Channel not found" }); return; }
    // Tell broadcaster they've been taken down
    io.to(bcId).emit("admin:forced-takedown", { reason: "Taken off-air by administrator." });
    // Tell viewers
    io.to(`viewers:${channelId}`).emit("broadcaster-left");
    channelBroadcasters.delete(channelId);
    broadcasterChannels.delete(bcId);
    channelThumbnails.delete(channelId);
    io.emit("channels-updated", listLiveChannels());
    notifyAdmins("admin:channels-updated", listLiveChannels());
    if (typeof ack === "function") ack({ ok: true });
  });

  // ── DISCONNECT ──────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    adminSockets.delete(socket.id);

    const ch = broadcasterChannels.get(socket.id);
    if (ch) {
      channelBroadcasters.delete(ch);
      broadcasterChannels.delete(socket.id);
      channelThumbnails.delete(ch);
      io.emit("channels-updated", listLiveChannels());
      notifyAdmins("admin:channels-updated", listLiveChannels());
      io.to(`viewers:${ch}`).emit("broadcaster-left");
      return;
    }
    const vc = viewerChannels.get(socket.id);
    if (vc) {
      viewerChannels.delete(socket.id);
      const bcId = channelBroadcasters.get(vc);
      if (bcId) io.to(bcId).emit("viewer-gone", { viewerId: socket.id });
    }
  });
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Port ${PORT} already in use.\n`);
    process.exit(1);
  } else throw err;
});

server.listen(PORT, () => {
  console.log(`\n✅  http://localhost:${PORT}`);
  console.log(`📡  Broadcaster: http://localhost:${PORT}/broadcaster/`);
  console.log(`📺  Client:      http://localhost:${PORT}/client/`);
  console.log(`🛡️   Admin:       http://localhost:${PORT}/admin/`);
  console.log(`\n  CNAME setup (all → summerday.onrender.com):`);
  console.log(`    watch.skybound.at     → /client`);
  console.log(`    broadcast.skybound.at → /broadcaster`);
  console.log(`    admin.skybound.at     → /admin\n`);
});
