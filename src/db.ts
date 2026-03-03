import { createClient, type Client as LibsqlClient } from '@libsql/client';

let db: LibsqlClient;

export interface UserRecord {
  discord_id: string;
  stars: number;
  last_updated: number;
}

// 初始化 DB，沒設 TURSO_URL 時會用本機檔案
export const initDB = async () => {
  if (!db) {
    const url = process.env.TURSO_URL || 'file:patrol.sqlite';
    db = createClient({
      url,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }

  await db.executeMultiple(`
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
  console.log('Turso 資料表初始化完成');
};

export const getUserRecord = async (userId: string): Promise<UserRecord | undefined> => {
  const result = await db.execute({ sql: 'SELECT * FROM users WHERE discord_id = ?', args: [userId] });
  if (result.rows.length === 0) return undefined;
  const row = result.rows[0];
  return { discord_id: row.discord_id as string, stars: row.stars as number, last_updated: row.last_updated as number };
};

export const updateUserStars = async (userId: string, newStars: number) => {
  if (newStars < 0 || newStars > 4) throw new RangeError(`星數超出合法範圍 (0-4)，收到: ${newStars}`);
  await db.execute({
    sql: `INSERT INTO users (discord_id, stars, last_updated) VALUES (?, ?, ?)
          ON CONFLICT(discord_id) DO UPDATE SET stars = excluded.stars, last_updated = excluded.last_updated`,
    args: [userId, newStars, Date.now()],
  });
};

export const runWeeklyDecay = async () => {
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const result = await db.execute({
    sql: 'UPDATE users SET stars = stars - 1, last_updated = ? WHERE stars > 0 AND last_updated < ?',
    args: [Date.now(), oneWeekAgo],
  });

  if (result.rowsAffected > 0) {
    console.log(`每週降星排程完成，共調降 ${result.rowsAffected} 名使用者`);
  }
};

export const getGuildSetting = async (guildId: string): Promise<{ report_channel_id: string | null, ignored_roles: string | null, ignored_users: string | null } | undefined> => {
  const result = await db.execute({ sql: 'SELECT * FROM settings WHERE guild_id = ?', args: [guildId] });
  if (result.rows.length === 0) return undefined;
  const row = result.rows[0];
  return {
    report_channel_id: row.report_channel_id as string | null,
    ignored_roles: row.ignored_roles as string | null,
    ignored_users: row.ignored_users as string | null,
  };
};

export const updateGuildSetting = async (guildId: string, key: 'report_channel_id' | 'ignored_roles' | 'ignored_users', value: string) => {
  const validKeys = ['report_channel_id', 'ignored_roles', 'ignored_users'];
  if (!validKeys.includes(key)) throw new Error('Invalid setting key');

  await db.execute({
    sql: `INSERT INTO settings (guild_id, ${key}) VALUES (?, ?)
          ON CONFLICT(guild_id) DO UPDATE SET ${key} = excluded.${key}`,
    args: [guildId, value],
  });
};

// 測試用：注入替代的 DB 實例
export const _setDbForTest = (testClient: LibsqlClient) => {
  db = testClient;
};
