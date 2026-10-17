import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const file = process.env.DB_PATH || './data/dailymeal.db';
mkdirSync(dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS menu_days (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  meals TEXT NOT NULL,
  PRIMARY KEY (user_id, date)
);
CREATE TABLE IF NOT EXISTS day_events (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (user_id, date)
);
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  weekday INTEGER NOT NULL,
  title TEXT NOT NULL COLLATE NOCASE,
  items TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, slot, weekday, title)
);
CREATE TABLE IF NOT EXISTS weights (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  kg REAL NOT NULL,
  PRIMARY KEY (user_id, date)
);
`);

const json = (row, col) => (row ? JSON.parse(row[col]) : null);

export const q = {
  userByName: (u) => db.prepare('SELECT * FROM users WHERE username = ?').get(u),
  userCount: () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  createUser: (username, name, hash) =>
    db.prepare('INSERT INTO users (username, name, pass_hash) VALUES (?, ?, ?)').run(username, name, hash).lastInsertRowid,
  settings: (uid) => json(db.prepare('SELECT settings FROM users WHERE id = ?').get(uid), 'settings') || {},
  saveSettings: (uid, s) => db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(s), uid),

  createSession: (token, uid, expires) => db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(token, uid, expires),
  sessionUser: (token) =>
    db.prepare(`SELECT u.id, u.username, u.name FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.token = ? AND s.expires > ?`).get(token, Date.now()),
  deleteSession: (token) => db.prepare('DELETE FROM sessions WHERE token = ?').run(token),

  plan: (uid) => json(db.prepare('SELECT data FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(uid), 'data'),
  planMeta: (uid) => db.prepare('SELECT filename, created_at FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(uid),
  savePlan: (uid, filename, data) =>
    db.prepare('INSERT INTO plans (user_id, filename, data) VALUES (?, ?, ?)').run(uid, filename, JSON.stringify(data)),

  menuDay: (uid, date) => json(db.prepare('SELECT meals FROM menu_days WHERE user_id = ? AND date = ?').get(uid, date), 'meals'),
  menuRange: (uid, from, to) =>
    db.prepare('SELECT date, meals FROM menu_days WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date')
      .all(uid, from, to).map((r) => ({ date: r.date, meals: JSON.parse(r.meals) })),
  lastMenuDate: (uid) => db.prepare('SELECT MAX(date) AS d FROM menu_days WHERE user_id = ?').get(uid).d,
  saveMenuDay: (uid, date, meals) =>
    db.prepare('INSERT OR REPLACE INTO menu_days VALUES (?, ?, ?)').run(uid, date, JSON.stringify(meals)),
  clearMenuFrom: (uid, date) => db.prepare('DELETE FROM menu_days WHERE user_id = ? AND date >= ?').run(uid, date),

  events: (uid, date) => json(db.prepare('SELECT data FROM day_events WHERE user_id = ? AND date = ?').get(uid, date), 'data') || {},
  saveEvents: (uid, date, data) => db.prepare('INSERT OR REPLACE INTO day_events VALUES (?, ?, ?)').run(uid, date, JSON.stringify(data)),

  favorites: (uid) =>
    db.prepare('SELECT id, slot, weekday, title, items, uses FROM favorites WHERE user_id = ? ORDER BY uses DESC, updated_at DESC')
      .all(uid).map((f) => ({ ...f, items: JSON.parse(f.items) })),
  saveFavorite: (uid, slot, weekday, title, items) =>
    db.prepare(`INSERT INTO favorites (user_id, slot, weekday, title, items) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (user_id, slot, weekday, title)
                DO UPDATE SET items = excluded.items, uses = uses + 1, updated_at = datetime('now')`)
      .run(uid, slot, weekday, title, JSON.stringify(items)),
  deleteFavorite: (uid, id) => db.prepare('DELETE FROM favorites WHERE user_id = ? AND id = ?').run(uid, id),

  weights: (uid) => db.prepare('SELECT date, kg FROM weights WHERE user_id = ? ORDER BY date DESC LIMIT 52').all(uid),
  saveWeight: (uid, date, kg) => db.prepare('INSERT OR REPLACE INTO weights VALUES (?, ?, ?)').run(uid, date, kg),
  deleteWeight: (uid, date) => db.prepare('DELETE FROM weights WHERE user_id = ? AND date = ?').run(uid, date),
};
