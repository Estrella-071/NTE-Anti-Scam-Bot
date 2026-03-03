/**
 * db.ts 單元測試
 * 使用 @libsql/client 的 file::memory: 模式（本地記憶體 SQLite）
 */

import { createClient } from '@libsql/client';
import { _setDbForTest, initDB, getUserRecord, updateUserStars, runWeeklyDecay, getGuildSetting, updateGuildSetting } from './db';

describe('資料庫模組', () => {
    beforeAll(async () => {
        // 注入測試用的記憶體資料庫
        const testClient = createClient({ url: 'file::memory:' });
        _setDbForTest(testClient);
        await initDB();
    });

    describe('initDB', () => {
        it('重複呼叫不應報錯', async () => {
            await expect(initDB()).resolves.not.toThrow();
        });
    });

    describe('getUserRecord', () => {
        it('查詢不存在的使用者應回傳 undefined', async () => {
            expect(await getUserRecord('non_existent_user')).toBeUndefined();
        });
    });

    describe('updateUserStars', () => {
        it('應能正常插入新使用者紀錄', async () => {
            await updateUserStars('user_insert_test', 1);
            const record = await getUserRecord('user_insert_test');
            expect(record).toBeDefined();
            expect(record!.stars).toBe(1);
            expect(record!.discord_id).toBe('user_insert_test');
        });

        it('應能更新既有使用者的星數', async () => {
            await updateUserStars('user_update_test', 1);
            await updateUserStars('user_update_test', 3);
            const record = await getUserRecord('user_update_test');
            expect(record!.stars).toBe(3);
        });

        it('星數設為 0 應正常運作', async () => {
            await updateUserStars('user_zero_star', 0);
            expect((await getUserRecord('user_zero_star'))!.stars).toBe(0);
        });

        it('星數設為 4 應正常運作', async () => {
            await updateUserStars('user_max_star', 4);
            expect((await getUserRecord('user_max_star'))!.stars).toBe(4);
        });

        it('星數為 -1 應拋出 RangeError', async () => {
            await expect(updateUserStars('user_negative', -1)).rejects.toThrow(RangeError);
        });

        it('星數為 5 應拋出 RangeError', async () => {
            await expect(updateUserStars('user_overflow', 5)).rejects.toThrow(RangeError);
        });
    });

    describe('runWeeklyDecay', () => {
        it('超過 7 天未活動的使用者應降星', async () => {
            const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
            const originalNow = Date.now;
            Date.now = () => eightDaysAgo;
            await updateUserStars('user_decay', 3);
            Date.now = originalNow;

            await runWeeklyDecay();

            const record = await getUserRecord('user_decay');
            expect(record!.stars).toBe(2);
        });

        it('7 天內活動的使用者不應受影響', async () => {
            await updateUserStars('user_recent', 2);
            await runWeeklyDecay();

            const record = await getUserRecord('user_recent');
            expect(record!.stars).toBe(2);
        });

        it('0 星的使用者不應再降星', async () => {
            const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
            const originalNow = Date.now;
            Date.now = () => eightDaysAgo;
            await updateUserStars('user_zero_decay', 0);
            Date.now = originalNow;

            await runWeeklyDecay();
            expect((await getUserRecord('user_zero_decay'))!.stars).toBe(0);
        });
    });

    describe('Guild 設定', () => {
        it('查詢不存在的伺服器設定應回傳 undefined', async () => {
            expect(await getGuildSetting('non_existent_guild')).toBeUndefined();
        });

        it('應能新增並讀取伺服器設定', async () => {
            await updateGuildSetting('guild_test', 'report_channel_id', 'channel_123');
            const setting = await getGuildSetting('guild_test');
            expect(setting).toBeDefined();
            expect(setting!.report_channel_id).toBe('channel_123');
        });

        it('應能更新既有的伺服器設定', async () => {
            await updateGuildSetting('guild_update', 'report_channel_id', 'old_channel');
            await updateGuildSetting('guild_update', 'report_channel_id', 'new_channel');
            expect((await getGuildSetting('guild_update'))!.report_channel_id).toBe('new_channel');
        });

        it('應能分別設定各個欄位', async () => {
            await updateGuildSetting('guild_multi', 'report_channel_id', 'ch_1');
            await updateGuildSetting('guild_multi', 'ignored_roles', 'role_a,role_b');
            await updateGuildSetting('guild_multi', 'ignored_users', 'user_x');

            const setting = await getGuildSetting('guild_multi');
            expect(setting!.report_channel_id).toBe('ch_1');
            expect(setting!.ignored_roles).toBe('role_a,role_b');
            expect(setting!.ignored_users).toBe('user_x');
        });
    });
});
