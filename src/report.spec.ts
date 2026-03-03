/**
 * report.ts 單元測試
 * 測試 maskMaliciousContent 的各種邊界情況及 sendReport 的防護邏輯
 */

import { Client } from 'discord.js';
import { maskMaliciousContent, sendReport, ReportPayload } from './report';
import * as db from './db';

describe('maskMaliciousContent', () => {
    it('無 URL 的純文字不應被修改', () => {
        const text = '這只是一段普通的訊息，不包含任何連結';
        expect(maskMaliciousContent(text)).toBe(text);
    });

    it('僅含域名無路徑的 URL 應正確遮蔽', () => {
        const result = maskMaliciousContent('http://example.com');
        expect(result).toBe('http://exa***.com');
    });

    it('含子域名的 URL 應正確遮蔽', () => {
        const result = maskMaliciousContent('https://sub.domain.example.com/path/to/page');
        expect(result).toContain('https://');
        expect(result).toContain('***');
        // 原始域名不應完整出現
        expect(result).not.toContain('sub.domain.example');
    });

    it('短路徑 URL (≤ 5 字元) 不截斷路徑', () => {
        const result = maskMaliciousContent('https://example.com/ab');
        expect(result).toBe('https://exa***.com/ab');
    });

    it('混合文字與多個 URL 應全部遮蔽', () => {
        const text = '快來看 http://evil.com/scam/link 還有 https://phishing.org/fake/page 真的！';
        const result = maskMaliciousContent(text);

        // 原始域名不應完整出現
        expect(result).not.toContain('evil.com');
        expect(result).not.toContain('phishing.org');
        // 周圍文字保持不變
        expect(result).toContain('快來看');
        expect(result).toContain('真的！');
    });

    it('不含 protocol 的網址不應被遮蔽', () => {
        const text = '去 example.com 看看';
        expect(maskMaliciousContent(text)).toBe(text);
    });
});

describe('sendReport', () => {
    it('未設定通報頻道時應跳過不報錯', async () => {
        jest.spyOn(db, 'getGuildSetting').mockResolvedValue(undefined);
        const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

        const mockClient = {} as Client;
        const payload: ReportPayload = {
            guildId: 'test_guild',
            offenderId: 'user_1',
            offenderTag: 'User#0001',
            avatarURL: 'https://cdn.discordapp.com/avatar.png',
            channelIds: ['ch_1'],
            reason: '測試原因',
            content: '測試內容',
            oldStars: 0,
            newStars: 1,
            actionTaken: '測試處置',
        };

        // 不應拋出錯誤
        await expect(sendReport(mockClient, payload)).resolves.toBeUndefined();
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('未設定通報頻道'));

        consoleSpy.mockRestore();
        jest.restoreAllMocks();
    });

    it('通報頻道非文字頻道時應跳過不報錯', async () => {
        jest.spyOn(db, 'getGuildSetting').mockResolvedValue({
            report_channel_id: 'non_text_channel',
            ignored_roles: null,
            ignored_users: null,
        });
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

        const mockClient = {
            channels: {
                fetch: jest.fn().mockResolvedValue({
                    isTextBased: () => false,
                }),
            },
        } as unknown as Client;

        const payload: ReportPayload = {
            guildId: 'test_guild',
            offenderId: 'user_1',
            offenderTag: 'User#0001',
            avatarURL: 'https://cdn.discordapp.com/avatar.png',
            channelIds: ['ch_1'],
            reason: '測試原因',
            content: '測試內容',
            oldStars: 0,
            newStars: 1,
            actionTaken: '測試處置',
        };

        await expect(sendReport(mockClient, payload)).resolves.toBeUndefined();
        expect(consoleSpy).toHaveBeenCalledWith('報案頻道不存在或非文字頻道');

        consoleSpy.mockRestore();
        jest.restoreAllMocks();
    });
});
