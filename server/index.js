import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import db from "./db.js";

const { JWT_SECRET, ALLOWED_ORIGIN, AUTH_EMAIL, AUTH_PASSWORD } = process.env;
if (!JWT_SECRET) throw new Error("JWT_SECRET is required");
if (!AUTH_EMAIL || !AUTH_PASSWORD) throw new Error("AUTH_EMAIL and AUTH_PASSWORD are required");

const OWNER = "owner";

const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(",") : "*" }));

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sign() {
  return jwt.sign({ sub: OWNER }, JWT_SECRET, { expiresIn: "30d" });
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.sub !== OWNER) throw new Error("bad subject");
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Email and password required" });
  }
  const emailOk = timingSafeStringEqual(email.trim().toLowerCase(), AUTH_EMAIL.toLowerCase());
  const passwordOk = timingSafeStringEqual(password, AUTH_PASSWORD);
  if (!emailOk || !passwordOk) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  res.json({ token: sign() });
});

app.get("/api/progress", auth, async (_req, res) => {
  const result = await db.execute({
    sql: "SELECT state FROM progress WHERE owner = ?",
    args: [OWNER],
  });
  res.json({ state: result.rows[0] ? JSON.parse(result.rows[0].state) : null });
});

app.put("/api/progress", auth, async (req, res) => {
  const { state } = req.body || {};
  if (state === undefined) return res.status(400).json({ error: "state required" });
  await db.execute({
    sql: `INSERT INTO progress (owner, state, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(owner) DO UPDATE SET state = excluded.state, updated_at = CURRENT_TIMESTAMP`,
    args: [OWNER, JSON.stringify(state)],
  });
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
