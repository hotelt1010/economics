import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import db from "./db.js";

const { JWT_SECRET, ALLOWED_ORIGIN } = process.env;
if (!JWT_SECRET) throw new Error("JWT_SECRET is required");

const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(",") : "*" }));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sign(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "30d" });
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.userId = jwt.verify(token, JWT_SECRET).sub;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/signup", async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Valid email required" });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await db.execute({
    sql: "SELECT id FROM users WHERE email = ?",
    args: [normalizedEmail],
  });
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: "Email already registered" });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await db.execute({
    sql: "INSERT INTO users (email, password_hash) VALUES (?, ?)",
    args: [normalizedEmail, passwordHash],
  });
  const userId = Number(result.lastInsertRowid);
  res.status(201).json({ token: sign(userId) });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Email and password required" });
  }
  const normalizedEmail = email.trim().toLowerCase();
  const result = await db.execute({
    sql: "SELECT id, password_hash FROM users WHERE email = ?",
    args: [normalizedEmail],
  });
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  res.json({ token: sign(user.id) });
});

app.get("/api/progress", auth, async (req, res) => {
  const result = await db.execute({
    sql: "SELECT state FROM progress WHERE user_id = ?",
    args: [req.userId],
  });
  res.json({ state: result.rows[0] ? JSON.parse(result.rows[0].state) : null });
});

app.put("/api/progress", auth, async (req, res) => {
  const { state } = req.body || {};
  if (state === undefined) return res.status(400).json({ error: "state required" });
  await db.execute({
    sql: `INSERT INTO progress (user_id, state, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = CURRENT_TIMESTAMP`,
    args: [req.userId, JSON.stringify(state)],
  });
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
