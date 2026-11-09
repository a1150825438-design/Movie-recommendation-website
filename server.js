// Backend
// Serves the static index.html and provides register / login / logout / current-user APIs.
// Persistence uses MySQL (see schema.sql / db.js). Start: npm install && npm start, then open http://localhost:3000
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pool, ensureSchema } = require("./db");

const PORT = process.env.PORT || 3000;

// —— DeepSeek AI Q&A (available to logged-in users) ——
// Paste your DeepSeek API key into the quotes below (or set the DEEPSEEK_API_KEY env var).
// Get one at: https://platform.deepseek.com/api_keys
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "sk-975826f9a51e4a8ba8a5309911155413";
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.static(__dirname));

// Wrap async handlers so Promise rejections go to the error middleware (avoids unhandled rejections)
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/* ---------- Password hashing (scrypt + salt, constant-time compare) ---------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, "hex");
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

/* ---------- Sessions & auth (sessions table) ---------- */

function issueToken(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  return pool
    .query(
      "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
      [token, userId, new Date().toISOString()]
    )
    .then(() => token);
}

async function getUserByToken(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const [rows] = await pool.query(
    "SELECT u.id, u.username, u.salt, u.hash, u.is_admin AS isAdmin, u.created_at AS createdAt, u.avatar AS avatar " +
      "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
    [token]
  );
  return rows[0] || null;
}

/* ---------- Notifications (notifications table) ---------- */

// Create a notification for the replied-to / liked user, with the actor, movie, comment and a content snapshot
async function addNotification({ type = "reply", userId, actorId, actorUsername, movieId, commentId, text, parentText = null }) {
  await pool.query(
    "INSERT INTO notifications (id, type, user_id, actor_id, actor_username, movie_id, comment_id, text, parent_text, is_read, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
    [crypto.randomUUID(), type, userId, actorId, actorUsername, movieId, commentId, text, parentText, new Date().toISOString()]
  );
}

/* ---------- Reviews: comment / rating / favorite ---------- */

// Summarize a movie's comments, average rating, favorites, and the current user's own rating / favorite state
async function movieSummary(movieId, user) {
  const [comments] = await pool.query(
    "SELECT c.id, c.movie_id AS movieId, c.parent_id AS parentId, c.user_id AS userId, c.username, c.text, c.created_at AS createdAt, u.avatar AS avatar, u.signature AS signature " +
      "FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.movie_id = ?",
    [movieId]
  );
  const [likes] = await pool.query(
    "SELECT movie_id AS movieId, comment_id AS commentId, user_id AS userId FROM likes WHERE movie_id = ?",
    [movieId]
  );
  const [ratings] = await pool.query(
    "SELECT movie_id AS movieId, user_id AS userId, rating FROM ratings WHERE movie_id = ?",
    [movieId]
  );
  const [favs] = await pool.query(
    "SELECT movie_id AS movieId, user_id AS userId FROM favorites WHERE movie_id = ?",
    [movieId]
  );

  const all = comments;
  // Likes: count likes per comment and mark whether the current user liked it
  const likeCounts = {};
  for (const l of likes) likeCounts[l.commentId] = (likeCounts[l.commentId] || 0) + 1;
  const likedByMe = user
    ? new Set(likes.filter((l) => l.userId === user.id).map((l) => l.commentId))
    : new Set();
  // Threaded comments: flatten each thread with depth (0 = top level, +1 per level) and replyToUsername.
  // Top-level comments newest first; replies within a thread oldest first.
  const childrenOf = {};
  for (const c of all) {
    if (c.parentId) (childrenOf[c.parentId] = childrenOf[c.parentId] || []).push(c);
  }
  const sortAsc = (arr) => arr.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const top = all
    .filter((c) => !c.parentId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const commentsOut = [];
  const walk = (c, depth, replyToUsername) => {
    commentsOut.push({
      ...c,
      depth,
      replyToUsername,
      likeCount: likeCounts[c.id] || 0,
      myLike: likedByMe.has(c.id),
    });
    for (const child of sortAsc(childrenOf[c.id] || [])) {
      walk(child, depth + 1, c.username);
    }
  };
  for (const c of top) walk(c, 0, null);

  const avg = ratings.length
    ? ratings.reduce((s, r) => s + r.rating, 0) / ratings.length
    : 0;
  return {
    comments: commentsOut,
    avgRating: Math.round(avg * 10) / 10,
    ratingCount: ratings.length,
    favorites: favs.length,
    myRating: user
      ? (ratings.find((r) => r.movieId === movieId && r.userId === user.id) || {}).rating || 0
      : 0,
    myFavorite: user ? favs.some((f) => f.userId === user.id) : false,
  };
}

function requireAuth(req, res, next) {
  getUserByToken(req)
    .then((user) => {
      if (!user) return res.status(401).json({ error: "Please log in first" });
      req.user = user;
      next();
    })
    .catch(next);
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

function parseMovieId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid movie ID" });
    return null;
  }
  return id;
}

/* ---------- Movie editing (admin overlay) ---------- */

const PLATFORM_KEYS = ["douban", "imdb", "rt", "letterboxd"];

// mysql2 may return JSON columns as strings or parsed objects; normalize to an object
function parseLinks(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// Convert a database row into the movie shape the frontend uses
function movieRowToJson(row) {
  return {
    id: row.id,
    tmdbId: row.tmdbId != null ? row.tmdbId : null,
    name: row.name,
    category: row.category,
    year: row.year,
    director: row.director,
    description: row.description,
    poster: row.poster || "",
    links: parseLinks(row.links),
  };
}

// Validate and normalize the movie edit body submitted by an admin
function parseMovieEdit(body) {
  const name = String((body && body.name) || "").trim();
  const category = String((body && body.category) || "").trim();
  const director = String((body && body.director) || "").trim();
  const description = String((body && body.description) || "").trim();
  const poster = String((body && body.poster) || "").trim();
  const year = Number(body && body.year);
  const tmdbId = body && (body.tmdbId === "" || body.tmdbId == null) ? null : Number(body && body.tmdbId);

  if (!name) return { error: "Please enter a movie title" };
  if (name.length > 200) return { error: "Title must be at most 200 characters" };
  if (!category) return { error: "Please enter a genre" };
  if (category.length > 50) return { error: "Genre must be at most 50 characters" };
  if (!director) return { error: "Please enter a director" };
  if (director.length > 100) return { error: "Director must be at most 100 characters" };
  if (!description) return { error: "Please enter a description" };
  if (description.length > 2000) return { error: "Description must be at most 2000 characters" };
  if (poster.length > 500) return { error: "Poster URL must be at most 500 characters" };
  if (!Number.isInteger(year) || year < 1888 || year > 2100) return { error: "Year must be an integer from 1888 to 2100" };
  if (tmdbId != null && (!Number.isInteger(tmdbId) || tmdbId <= 0)) return { error: "TMDB ID must be a positive integer" };

  const linksRaw = (body && body.links) || {};
  const links = {};
  for (const k of PLATFORM_KEYS) {
    const v = String(linksRaw[k] || "").trim();
    if (v.length > 255) return { error: "Platform link must be at most 255 characters" };
    if (v) links[k] = v;
  }
  const custom = [];
  const rawCustom = Array.isArray(linksRaw.custom) ? linksRaw.custom : [];
  for (const c of rawCustom) {
    const label = String((c && c.label) || "").trim();
    const url = String((c && c.url) || "").trim();
    if (!label && !url) continue;
    if (!label || !url) return { error: "Custom links need both a label and a URL" };
    if (label.length > 50) return { error: "Custom link label must be at most 50 characters" };
    if (url.length > 500) return { error: "Custom link URL must be at most 500 characters" };
    if (!/^https?:\/\//i.test(url)) return { error: "Custom link must start with http(s)://" };
    custom.push({ label, url });
  }
  if (custom.length > 20) return { error: "At most 20 custom links" };
  if (custom.length) links.custom = custom;

  return {
    movie: {
      tmdbId,
      name,
      category,
      year,
      director,
      description,
      poster,
      links: Object.keys(links).length ? links : null,
    },
  };
}

/* ---------- API ---------- */

app.post("/api/register", wrap(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!username) return res.status(400).json({ error: "Please enter a username" });
  if (username.length > 24) return res.status(400).json({ error: "Username must be at most 24 characters" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  const [existing] = await pool.query("SELECT id FROM users WHERE username = ?", [username]);
  if (existing.length) return res.status(409).json({ error: "This username is already taken" });

  const { salt, hash } = hashPassword(password);
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO users (id, username, salt, hash, is_admin, created_at) VALUES (?, ?, ?, ?, 0, ?)",
    [id, username, salt, hash, new Date().toISOString()]
  );

  // Auto-login right after a successful registration
  const token = await issueToken(id);
  res.json({ token, username, avatar: "" });
}));

app.post("/api/login", wrap(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  const [rows] = await pool.query(
    "SELECT id, username, salt, hash, is_admin AS isAdmin, created_at AS createdAt, avatar FROM users WHERE username = ?",
    [username]
  );
  const user = rows[0];
  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: "Incorrect username or password" });
  }

  const token = await issueToken(user.id);
  res.json({ token, username: user.username, isAdmin: !!user.isAdmin, avatar: user.avatar || "" });
}));

app.post("/api/logout", wrap(async (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token) await pool.query("DELETE FROM sessions WHERE token = ?", [token]);
  res.json({ ok: true });
}));

app.get("/api/me", wrap(async (req, res) => {
  const user = await getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  res.json({ username: user.username, isAdmin: !!user.isAdmin, avatar: user.avatar || "" });
}));

app.get("/api/movies", wrap(async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, tmdb_id AS tmdbId, name, category, year, director, description, poster, links FROM movies ORDER BY id"
  );
  res.json({ movies: rows.map(movieRowToJson) });
}));

// All movies' real in-site average rating and count (for recommendation cards; no login required)
app.get("/api/movies/ratings", wrap(async (req, res) => {
  const [rows] = await pool.query(
    "SELECT movie_id AS movieId, AVG(rating) AS avg, COUNT(*) AS c FROM ratings GROUP BY movie_id"
  );
  res.json({
    ratings: rows.map((r) => ({
      movieId: r.movieId,
      avgRating: Math.round(Number(r.avg) * 10) / 10,
      ratingCount: Number(r.c),
    })),
  });
}));

app.get("/api/movies/:id", wrap(async (req, res) => {
  const movieId = parseMovieId(req, res);
  if (movieId === null) return;
  res.json(await movieSummary(movieId, await getUserByToken(req)));
}));

app.post("/api/movies/:id/comments", requireAuth, wrap(async (req, res) => {
  const movieId = parseMovieId(req, res);
  if (movieId === null) return;
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "Review cannot be empty" });
  if (text.length > 500) return res.status(400).json({ error: "Review must be at most 500 characters" });

  await pool.query(
    "INSERT INTO comments (id, movie_id, parent_id, user_id, username, text, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)",
    [crypto.randomUUID(), movieId, req.user.id, req.user.username, text, new Date().toISOString()]
  );
  res.json(await movieSummary(movieId, req.user));
}));

//Remove comments
app.delete("/api/movies/:id/comments/:commentId", requireAuth, wrap(async (req, res) => {
  const movieId = parseMovieId(req, res); //Check whether the movie id is an integer. If not, terminate execution.
  if (movieId === null) return; //If the movieid is null, terminate execution.
  const commentId = String(req.params.commentId || ""); //Get the comment id.
  if (!commentId) return res.status(400).json({ error: "Invalid comment ID" });//If the commenId does not exist, terminate execution

  const [comments] = await pool.query(
    "SELECT id, movie_id AS movieId, parent_id AS parentId, user_id AS userId FROM comments WHERE movie_id = ?",
    [movieId]
  );
  const target = comments.find((c) => c.id === commentId);
  if (!target) return res.status(404).json({ error: "Review not found or already deleted" }); //If the comment does not exist, return error.
  if (target.userId !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: "You can only delete your own review" });
  }//If the current user is not an administrator and the comment does not belong to it, return error.

  const toRemove = new Set([commentId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of comments) {
      if (c.parentId && toRemove.has(c.parentId) && !toRemove.has(c.id)) {
        toRemove.add(c.id);
        changed = true;
      }
    }
  } //Use a while loop to collect all replies under this comment. The variable "changed" can check whether the comment has other replies.
  const ids = [...toRemove];
  const placeholders = ids.map(() => "?").join(", ");
  await pool.query(`DELETE FROM comments WHERE id IN (${placeholders})`, ids); //Remove the comment and its replies.
  await pool.query(`DELETE FROM likes WHERE comment_id IN (${placeholders})`, ids); //Remove likes on deleted comments and replies. 
  res.json(await movieSummary(movieId, req.user));
}));

app.post("/api/movies/:id/comments/:commentId/replies", requireAuth, wrap(async (req, res) => {
  const movieId = parseMovieId(req, res);
  if (movieId === null) return;
  const commentId = String(req.params.commentId || "");
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "Reply cannot be empty" });//If the reply is empty, return error
  if (text.length > 500) return res.status(400).json({ error: "Reply must be at most 500 characters" });//If the reply is more than 500 characters, return error

  const [parents] = await pool.query(
    "SELECT id, user_id AS userId, username, text FROM comments WHERE id = ? AND movie_id = ?",
    [commentId, movieId]
  );
  const parent = parents[0];
  if (!parent) return res.status(404).json({ error: "Review not found or already deleted" });

  await pool.query(
    "INSERT INTO comments (id, movie_id, parent_id, user_id, username, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [crypto.randomUUID(), movieId, commentId, req.user.id, req.user.username, text, new Date().toISOString()]
  );

  // On reply, notify the replied-to user (the parent comment author); no notification for self-reply
  if (parent.userId !== req.user.id) {
    await addNotification({
      type: "reply",
      userId: parent.userId,
      actorId: req.user.id,
      actorUsername: req.user.username,
      movieId,
      commentId: parent.id,
      text,
      parentText: parent.text,
    });
  }

  res.json(await movieSummary(movieId, req.user));
}));

app.post("/api/movies/:id/comments/:commentId/like", requireAuth, wrap(async (req, res) => {
  const movieId = parseMovieId(req, res);
  if (movieId === null) return;
  const commentId = String(req.params.commentId || "");
  if (!commentId) return res.status(400).json({ error: "Invalid comment ID" });

  const [targets] = await pool.query(
    "SELECT id, user_id AS userId, text FROM comments WHERE id = ? AND movie_id = ?",
    [commentId, movieId]
  );
  const target = targets[0];
  if (!target) return res.status(404).json({ error: "Review not found or already deleted" });

  // Toggle like: unlike if already liked, otherwise like
  const [existing] = await pool.query(
    "SELECT comment_id AS commentId FROM likes WHERE comment_id = ? AND user_id = ?",
    [commentId, req.user.id]
  );
  let liked = false;
  if (existing.length) {
    await pool.query("DELETE FROM likes WHERE comment_id = ? AND user_id = ?", [commentId, req.user.id]);
  } else {
    await pool.query("INSERT INTO likes (movie_id, comment_id, user_id) VALUES (?, ?, ?)", [movieId, commentId, req.user.id]);
    liked = true;
  }

  // On like, notify the comment author; no notification for self-like
  if (liked && target.userId !== req.user.id) {
    await addNotification({
      type: "like",
      userId: target.userId,
      actorId: req.user.id,
      actorUsername: req.user.username,
      movieId,
      commentId: target.id,
      text: target.text,
    });
  }

  res.json(await movieSummary(movieId, req.user));
}));

app.post("/api/movies/:id/rating", requireAuth, wrap(async (req, res) => {
  const movieId = parseMovieId(req, res);
  if (movieId === null) return;
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 0 || rating > 10) {
    return res.status(400).json({ error: "Rating must be an integer from 0 to 10" });
  }

  if (rating === 0) {
    await pool.query("DELETE FROM ratings WHERE movie_id = ? AND user_id = ?", [movieId, req.user.id]);
  } else {
    await pool.query(
      "INSERT INTO ratings (movie_id, user_id, rating) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE rating = VALUES(rating)",
      [movieId, req.user.id, rating]
    );
  }
  res.json(await movieSummary(movieId, req.user));
}));

app.post("/api/movies/:id/favorite", requireAuth, wrap(async (req, res) => {
  const movieId = parseMovieId(req, res);
  if (movieId === null) return;

  const [existing] = await pool.query(
    "SELECT user_id AS userId FROM favorites WHERE movie_id = ? AND user_id = ?",
    [movieId, req.user.id]
  );
  if (existing.length) {
    await pool.query("DELETE FROM favorites WHERE movie_id = ? AND user_id = ?", [movieId, req.user.id]);
  } else {
    await pool.query("INSERT INTO favorites (movie_id, user_id, created_at) VALUES (?, ?, ?)", [movieId, req.user.id, new Date().toISOString()]);
  }
  res.json(await movieSummary(movieId, req.user));
}));

app.get("/api/me/favorites", requireAuth, wrap(async (req, res) => {
  const [rows] = await pool.query(
    "SELECT movie_id AS movieId FROM favorites WHERE user_id = ? ORDER BY created_at DESC",
    [req.user.id]
  );
  res.json({ favorites: rows.map((r) => r.movieId) });
}));

/* ---------- My account (profile) ---------- */

// My account: username, signature, favorited movies, and total likes received
app.get("/api/me/profile", requireAuth, wrap(async (req, res) => {
  const [profileRows] = await pool.query(
    "SELECT signature FROM users WHERE id = ?",
    [req.user.id]
  );
  const profile = profileRows[0] || {};

  const [favRows] = await pool.query(
    "SELECT movie_id AS movieId FROM favorites WHERE user_id = ? ORDER BY created_at DESC",
    [req.user.id]
  );
  const [likeRows] = await pool.query(
    "SELECT COUNT(*) AS c FROM likes l JOIN comments c ON c.id = l.comment_id WHERE c.user_id = ?",
    [req.user.id]
  );

  res.json({
    username: req.user.username,
    avatar: req.user.avatar || "",
    signature: profile.signature || "",
    favorites: favRows.map((r) => r.movieId),
    likeReceivedTotal: Number(likeRows[0].c) || 0,
  });
}));

// Update signature
app.put("/api/me/profile", requireAuth, wrap(async (req, res) => {
  const signature = String((req.body && req.body.signature) || "").trim();
  if (signature.length > 200) return res.status(400).json({ error: "Signature must be at most 200 characters" });

  await pool.query(
    "UPDATE users SET signature = ? WHERE id = ?",
    [signature || null, req.user.id]
  );
  res.json({ ok: true, signature });
}));

/* ---------- avatar ---------- */

// Avatar storage directory and limits
const AVATAR_DIR = path.join(__dirname, "uploads", "avatars");
const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const AVATAR_TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };

// Verify decoded bytes match the declared image type (magic numbers), to avoid saving non-image content as an avatar
function isImage(buf, mime) {
  if (mime === "image/png") return buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (mime === "image/jpeg") return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === "image/gif") return buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF";
  if (mime === "image/webp") return buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
  return false;
}

// Upload avatar: the frontend submits a data URL (base64); write to uploads/avatars and update users.avatar
app.post("/api/me/avatar", requireAuth, wrap(async (req, res) => {
  const dataUrl = String((req.body && req.body.avatar) || "").trim();
  if (!dataUrl) return res.status(400).json({ error: "Please choose an image" });

  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return res.status(400).json({ error: "Only PNG / JPG / WebP / GIF images are supported" });

  const mime = m[1];
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length || !isImage(buf, mime)) return res.status(400).json({ error: "Invalid image data" });
  if (buf.length > AVATAR_MAX_BYTES) return res.status(400).json({ error: "Image must be at most 2MB" });

  await fs.promises.mkdir(AVATAR_DIR, { recursive: true });

  // Delete the user's previous avatar file to avoid leftovers
  const prev = await fs.promises.readdir(AVATAR_DIR).catch(() => []);
  for (const f of prev) {
    if (f.startsWith(req.user.id + "-")) {
      await fs.promises.unlink(path.join(AVATAR_DIR, f)).catch(() => {});
    }
  }

  const filename = req.user.id + "-" + Date.now() + AVATAR_TYPES[mime];
  await fs.promises.writeFile(path.join(AVATAR_DIR, filename), buf);

  const avatarUrl = "/uploads/avatars/" + filename;
  await pool.query("UPDATE users SET avatar = ? WHERE id = ?", [avatarUrl, req.user.id]);
  res.json({ avatar: avatarUrl });
}));

// The current user's comment history, grouped by movie (most recent first), with their rating per movie
app.get("/api/me/history", requireAuth, wrap(async (req, res) => {
  const [myComments] = await pool.query(
    "SELECT id, movie_id AS movieId, parent_id AS parentId, user_id AS userId, username, text, created_at AS createdAt " +
      "FROM comments WHERE user_id = ? ORDER BY created_at DESC",
    [req.user.id]
  );
  const [ratings] = await pool.query(
    "SELECT movie_id AS movieId, rating FROM ratings WHERE user_id = ?",
    [req.user.id]
  );

  const ratingByMovie = {};
  for (const r of ratings) ratingByMovie[r.movieId] = r.rating;

  const grouped = {};
  const order = [];
  for (const c of myComments) {
    if (!grouped[c.movieId]) { grouped[c.movieId] = []; order.push(c.movieId); }
    grouped[c.movieId].push(c);
  }

  const history = order.map((movieId) => ({
    movieId,
    rating: ratingByMovie[movieId] || 0,
    comments: grouped[movieId],
  }));
  res.json({ history });
}));

/* ---------- Admin ---------- */

// Edit movie info and platform links (admin only; overlay layer: only edited movies are stored)
app.put("/api/movies/:id", requireAuth, requireAdmin, wrap(async (req, res) => {
  const movieId = parseMovieId(req, res);
  if (movieId === null) return;

  const parsed = parseMovieEdit(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const m = parsed.movie;

  const links = m.links ? JSON.stringify(m.links) : null;
  await pool.query(
    "INSERT INTO movies (id, tmdb_id, name, category, year, rating, director, description, poster, links, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?) " +
      "ON DUPLICATE KEY UPDATE tmdb_id = VALUES(tmdb_id), name = VALUES(name), category = VALUES(category), " +
      "year = VALUES(year), director = VALUES(director), description = VALUES(description), " +
      "poster = VALUES(poster), links = VALUES(links), updated_at = VALUES(updated_at)",
    [movieId, m.tmdbId, m.name, m.category, m.year, m.director, m.description, m.poster, links, new Date().toISOString()]
  );

  res.json({ movie: { id: movieId, ...m } });
}));

// List all registered users (admin only)
app.get("/api/admin/users", requireAuth, requireAdmin, wrap(async (req, res) => {
  const [users] = await pool.query(
    "SELECT id, username, is_admin AS isAdmin, created_at AS createdAt FROM users ORDER BY created_at DESC"
  );
  const [counts] = await pool.query("SELECT user_id AS userId, COUNT(*) AS c FROM comments GROUP BY user_id");
  const countByUser = {};
  for (const row of counts) countByUser[row.userId] = Number(row.c) || 0;

  const list = users.map((u) => ({
    id: u.id,
    username: u.username,
    isAdmin: !!u.isAdmin,
    createdAt: u.createdAt,
    commentCount: countByUser[u.id] || 0,
  }));
  res.json({ users: list });
}));

// Delete a user account (admin only): cascade-delete their comments, replies, likes, ratings, favorites, notifications and sessions
app.delete("/api/admin/users/:userId", requireAuth, requireAdmin, wrap(async (req, res) => {
  const userId = String(req.params.userId || "");
  if (!userId) return res.status(400).json({ error: "Invalid user ID" });

  const [targets] = await pool.query(
    "SELECT id, username, is_admin AS isAdmin FROM users WHERE id = ?",
    [userId]
  );
  const target = targets[0];
  if (!target) return res.status(404).json({ error: "User not found or already deleted" });
  if (target.id === req.user.id) return res.status(400).json({ error: "You cannot delete your own account" });
  if (target.isAdmin) return res.status(403).json({ error: "You cannot delete an admin account" });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // All of the user's comments, together with all descendant replies, are deleted (to avoid dangling parent_id)
    const [comments] = await conn.query("SELECT id, parent_id AS parentId, user_id AS userId FROM comments");
    const toRemove = new Set();
    for (const c of comments) if (c.userId === userId) toRemove.add(c.id);
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of comments) {
        if (c.parentId && toRemove.has(c.parentId) && !toRemove.has(c.id)) {
          toRemove.add(c.id);
          changed = true;
        }
      }
    }
    if (toRemove.size) {
      const ids = [...toRemove];
      const placeholders = ids.map(() => "?").join(", ");
      await conn.query(`DELETE FROM likes WHERE comment_id IN (${placeholders})`, ids);
      await conn.query(`DELETE FROM comments WHERE id IN (${placeholders})`, ids);
    }

    // The user's likes, ratings, favorites, notifications (as recipient/actor) and sessions
    await conn.query("DELETE FROM likes WHERE user_id = ?", [userId]);
    await conn.query("DELETE FROM ratings WHERE user_id = ?", [userId]);
    await conn.query("DELETE FROM favorites WHERE user_id = ?", [userId]);
    await conn.query("DELETE FROM notifications WHERE user_id = ? OR actor_id = ?", [userId, userId]);
    await conn.query("DELETE FROM sessions WHERE user_id = ?", [userId]);
    await conn.query("DELETE FROM users WHERE id = ?", [userId]);

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}));

/* ---------- Notifications ---------- */

// The current user's notification list (newest first) and unread count
app.get("/api/notifications", requireAuth, wrap(async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, type, user_id AS userId, actor_id AS actorId, actor_username AS actorUsername, " +
      "movie_id AS movieId, comment_id AS commentId, text, parent_text AS parentText, is_read AS `read`, created_at AS createdAt " +
      "FROM notifications WHERE user_id = ? ORDER BY created_at DESC",
    [req.user.id]
  );
  const list = rows.map((n) => ({ ...n, read: !!n.read }));
  const unread = list.filter((n) => !n.read).length;
  res.json({ notifications: list, unread });
}));

// Mark all of the current user's messages as read
app.post("/api/notifications/read", requireAuth, wrap(async (req, res) => {
  await pool.query("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0", [req.user.id]);
  res.json({ unread: 0 });
}));

/* ---------- AI Q&A (DeepSeek, logged-in users) ---------- */

// Assemble the library the frontend sends into a system prompt so the AI can answer using the site's library
function buildAiSystemPrompt(movies) {
  const list = (Array.isArray(movies) ? movies : []).map((m) => {
    return `- "${m.name}" (${m.year}, ${m.category}, directed by ${m.director}, site rating ${m.rating}): ${m.description}`;
  }).join("\n");
  return (
    "You are the built-in AI movie assistant for the 'Yingjian' movie recommendation site, skilled at recommending movies, introducing plots, and answering movie-related questions.\n" +
    "Here is the site's movie library (" + (Array.isArray(movies) ? movies.length : 0) + " titles):\n" + list +
    "\n\nAnswer requirements:\n" +
    "1. Answer in English;\n" +
    "2. Prefer recommending from the site's library, and feel free to supplement with other great films;\n" +
    "3. Be concise and friendly; warn first when spoilers are involved;\n" +
    "4. Only answer movie-related questions; politely steer off-topic questions back to movies."
  );
}

app.post("/api/ai/ask", requireAuth, wrap(async (req, res) => {
  const question = String(req.body.question || "").trim();
  if (!question) return res.status(400).json({ error: "Please enter a question" });
  if (question.length > 2000) return res.status(400).json({ error: "Question must be at most 2000 characters" });
  if (!DEEPSEEK_API_KEY) return res.status(503).json({ error: "DeepSeek API key is not configured" });

  // Keep the last 16 messages of conversation history (user / assistant only)
  const history = (Array.isArray(req.body.history) ? req.body.history : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  const messages = [
    { role: "system", content: buildAiSystemPrompt(req.body.movies) },
    ...history,
    { role: "user", content: question },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let resp;
  try {
    resp = await fetch(DEEPSEEK_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + DEEPSEEK_API_KEY,
      },
      body: JSON.stringify({ model: DEEPSEEK_MODEL, messages, temperature: 0.7, max_tokens: 1200, stream: false }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return res.status(502).json({ error: e && e.name === "AbortError" ? "AI response timed out. Please try again." : "Cannot connect to the AI service" });
  }
  clearTimeout(timer);

  if (!resp.ok) {
    let detail = "";
    try {
      const err = await resp.json();
      detail = (err && err.error && err.error.message) || "";
    } catch (e) {}
    if (resp.status === 401 || resp.status === 403) {
      return res.status(502).json({ error: "DeepSeek API key is invalid or expired" });
    }
    if (resp.status === 429) return res.status(429).json({ error: "Too many AI requests. Please try again later." });
    return res.status(502).json({ error: "AI service returned an error" + (detail ? ": " + detail : "") });
  }

  const data = await resp.json();
  const answer = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!answer) return res.status(502).json({ error: "AI returned no content. Please try again." });
  res.json({ answer });
}));

/* ---------- Admin account (ensured on startup) ---------- */

async function ensureAdminUser() {
  const [rows] = await pool.query("SELECT id, is_admin AS isAdmin FROM users WHERE username = ?", ["admin1"]);
  const admin = rows[0];
  if (!admin) {
    const { salt, hash } = hashPassword("123456");
    await pool.query(
      "INSERT INTO users (id, username, salt, hash, is_admin, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      [crypto.randomUUID(), "admin1", salt, hash, new Date().toISOString()]
    );
    console.log("Created admin account admin1");
  } else if (!admin.isAdmin) {
    await pool.query("UPDATE users SET is_admin = 1 WHERE id = ?", [admin.id]);
  }
}

/* ---------- Unified error handling ---------- */

app.use((err, req, res, next) => {
  console.error("Server error:", err && err.message ? err.message : err);
  res.status(500).json({ error: "Internal server error" });
});

/* ---------- Startup ---------- */

(async () => {
  try {
    await ensureSchema();
  } catch (e) {
    console.error("Failed to initialize MySQL (make sure MySQL is running and DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME are configured correctly):", e.message);
    process.exit(1);
  }
  await ensureAdminUser();

  app.listen(PORT, () => {
    console.log(`Yingjian backend started at:http://localhost:${PORT}`);
  });
})();
