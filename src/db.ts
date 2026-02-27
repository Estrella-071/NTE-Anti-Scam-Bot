import Database from 'better-sqlite3';
import * as path from 'path';

const db = new Database(path.join(process.cwd(), 'patrol.sqlite'));

export interface UserRecord {
  discord_id: string;
  stars: number;
  last_updated: number;
}

export const initDB = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      stars INTEGER DEFAULT 0,
      last_updated INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      guild_id TEXT PRIMARY KEY,
      report_channel_id TEXT,
      ignored_roles TEXT,
      ignored_users TEXT
    );
  `);
  console.log('SQLite 資料表初始化完成');
};

export const getUserRecord = (userId: string): UserRecord | undefined =>
  db.prepare('SELECT * FROM users WHERE discord_id = ?').get(userId) as UserRecord | undefined;

export const updateUserStars = (userId: string, newStars: number) => {
  if (newStars < 0 || newStars > 4) throw new RangeError(`星數超出合法範圍 (0-4)，收到: ${newStars}`);
  db.prepare(`
    INSERT INTO users (discord_id, stars, last_updated) VALUES (?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET stars = excluded.stars, last_updated = excluded.last_updated
  `).run(userId, newStars, Date.now());
};

export const runWeeklyDecay = () => {
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const result = db.prepare(`
    UPDATE users SET stars = stars - 1, last_updated = ? WHERE stars > 0 AND last_updated < ?
  `).run(Date.now(), oneWeekAgo);

  if (result.changes > 0) {
    console.log(`每週降星排程完成，共調降 ${result.changes} 名使用者`);
  }
};

export const getGuildSetting = (guildId: string): { report_channel_id: string | null, ignored_roles: string | null, ignored_users: string | null } | undefined =>
  db.prepare('SELECT * FROM settings WHERE guild_id = ?').get(guildId) as any;

export const updateGuildSetting = (guildId: string, key: 'report_channel_id' | 'ignored_roles' | 'ignored_users', value: string) => {
  const validKeys = ['report_channel_id', 'ignored_roles', 'ignored_users'];
  if (!validKeys.includes(key)) throw new Error('Invalid setting key');

  db.prepare(`
    INSERT INTO settings (guild_id, ${key}) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET ${key} = excluded.${key}
  `).run(guildId, value);
};
