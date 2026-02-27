import { Client, Message } from 'discord.js';
import { patrolExecute } from './patrol';
import * as db from './db';
import * as report from './report';

jest.mock('./report', () => ({
    sendReport: jest.fn(),
    maskMaliciousContent: jest.requireActual('./report').maskMaliciousContent,
}));

describe('PatrolEngine - 快速洗版偵測', () => {
    let mockClient: jest.Mocked<Client>;
    let mockMessageFactory: (content: string, opts?: { privileged?: boolean; roleId?: string }) => jest.Mocked<Message>;
    let mockDelete: jest.Mock;
    let mockBulkDelete: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        mockBulkDelete = jest.fn().mockResolvedValue(undefined);
        const mockChannel = {
            isTextBased: () => true,
            bulkDelete: mockBulkDelete,
            messages: {
                fetch: jest.fn().mockImplementation((id: string) => Promise.resolve({ id, delete: jest.fn().mockResolvedValue(undefined) }))
            }
        };

        mockClient = {
            channels: { fetch: jest.fn().mockResolvedValue(mockChannel) },
        } as unknown as jest.Mocked<Client>;

        const userStarsDb: Record<string, number> = {};

        jest.spyOn(db, 'getUserRecord').mockImplementation(async (userId: string) => ({
            discord_id: userId,
            stars: userStarsDb[userId] || 0,
            last_updated: Date.now(),
        }));

        jest.spyOn(db, 'updateUserStars').mockImplementation(async (userId: string, stars: number) => {
            userStarsDb[userId] = stars;
        });

        jest.spyOn(db, 'getGuildSetting').mockImplementation(async (guildId: string) => {
            return {
                report_channel_id: 'mock_channel_id',
                ignored_roles: 'admin_role_id',
                ignored_users: 'whitelist_user_id',
            };
        });

        let msgCounter = 1;
        let tsCounter = Date.now();
        mockMessageFactory = (content: string, opts: { privileged?: boolean; roleId?: string } = {}) => {
            mockDelete = jest.fn().mockResolvedValue(undefined);
            const id = `msg_${msgCounter++}`;

            // 模擬 PermissionsBitField：privileged = 有 ManageMessages 權限
            const permHas = (perm: string) => opts.privileged && (perm === 'Administrator' || perm === 'ManageMessages');

            // 模擬 roles.cache：如果傳入 roleId，表示該使用者持有此 roleId
            const rolesCache = {
                some: (fn: (role: { id: string }) => boolean) =>
                    opts.roleId ? fn({ id: opts.roleId }) : false,
            };

            const testUserId = expect.getState().currentTestName ?
                `user_${expect.getState().currentTestName?.replace(/[^a-zA-Z0-9]/g, '')}` : 'user123';

            return {
                id,
                content,
                channelId: 'channel_1',
                author: {
                    id: testUserId,
                    tag: 'User#1234',
                    displayAvatarURL: jest.fn().mockReturnValue('https://cdn.discordapp.com/avatars/user123/abc.png'),
                },
                createdTimestamp: (tsCounter += 1000),
                member: {
                    permissions: { has: permHas },
                    roles: { cache: rolesCache },
                },
                guild: {
                    id: 'test_guild_123',
                    members: {
                        fetch: jest.fn().mockResolvedValue({
                            manageable: true,
                            timeout: jest.fn().mockResolvedValue(undefined),
                            ban: jest.fn().mockResolvedValue(undefined),
                        }),
                    },
                },
                delete: mockDelete,
            } as unknown as jest.Mocked<Message>;
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('單一訊息不應觸發處罰', async () => {
        const msg = mockMessageFactory('Hello World! This is a test message');
        await patrolExecute(msg, mockClient);

        expect(db.updateUserStars).not.toHaveBeenCalled();
        expect(msg.delete).not.toHaveBeenCalled();
    });

    it('連續 3 則重複訊息應觸發快速洗版', async () => {
        const msg1 = mockMessageFactory('Gift 50$ - http://example.com');
        const msg2 = mockMessageFactory('Gift 50$ - http://example.com');
        const msg3 = mockMessageFactory('Gift 50$ - http://example.com');

        await patrolExecute(msg1, mockClient);
        await patrolExecute(msg2, mockClient);
        await patrolExecute(msg3, mockClient);

        expect(db.updateUserStars).toHaveBeenCalledWith(msg1.author.id, 1);
        expect(mockClient.channels.fetch).toHaveBeenCalledWith('channel_1');

        // 驗證是否透過 bulkDelete 一次刪除了 3 則訊息
        expect(mockBulkDelete).toHaveBeenCalledWith([msg1.id, msg2.id, msg3.id]);

        expect(report.sendReport).toHaveBeenCalledWith(
            mockClient,
            expect.objectContaining({
                guildId: 'test_guild_123',
                offenderId: msg1.author.id,
                offenderTag: 'User#1234',
                oldStars: 0,
                newStars: 1,
                channelIds: ['channel_1'],
                content: 'Gift 50$ - http://example.com',
                reason: expect.stringContaining('短時間內高頻率發送訊息'),
            }),
        );
    });

    it('快速洗版應以出現最多次的內容作為提報樣本', async () => {
        const msg1 = mockMessageFactory('Not Spam (1)'); // +10
        const msg2 = mockMessageFactory('Not Spam (2)'); // +10
        const msg3 = mockMessageFactory('Real Spam Content'); // +10
        const msg4 = mockMessageFactory('Real Spam Content'); // 同內容 +45
        const msg5 = mockMessageFactory('Real Spam Content'); // 同內容 +45 -> 總計 = 120 >= 100 觸發洗版

        await patrolExecute(msg1, mockClient);
        jest.advanceTimersByTime(600);
        await patrolExecute(msg2, mockClient);
        jest.advanceTimersByTime(600);
        await patrolExecute(msg3, mockClient);
        jest.advanceTimersByTime(600);
        await patrolExecute(msg4, mockClient);
        jest.advanceTimersByTime(600);
        await patrolExecute(msg5, mockClient);

        expect(report.sendReport).toHaveBeenCalledWith(
            mockClient,
            expect.objectContaining({
                guildId: 'test_guild_123',
                content: 'Real Spam Content',
            }),
        );
    });

    it('正規化後相同內容的 hash 應一致（大小寫/空白不敏感）', async () => {
        const msg1 = mockMessageFactory('  Test   ');
        const msg2 = mockMessageFactory('test');

        await patrolExecute(msg1, mockClient);
        jest.advanceTimersByTime(600);
        await patrolExecute(msg2, mockClient);

        // 首次 10，第二次 10+35=45（同內容），水位約 55，未溢出
        expect(db.updateUserStars).not.toHaveBeenCalled();
    });

    it('跨頻道洗版應直接升至 4 星', async () => {
        const msg1 = mockMessageFactory('Spam message for cross-channel test');
        const msg2 = mockMessageFactory('Spam message for cross-channel test');
        const msg3 = mockMessageFactory('Spam message for cross-channel test');

        msg1.channelId = 'channel_1';
        msg2.channelId = 'channel_2';
        msg3.channelId = 'channel_3';

        await patrolExecute(msg1, mockClient);
        jest.advanceTimersByTime(1100);
        await patrolExecute(msg2, mockClient);
        jest.advanceTimersByTime(1100);
        await patrolExecute(msg3, mockClient);

        expect(db.updateUserStars).toHaveBeenCalledWith(msg1.author.id, 4);

        const fetched = await msg3.guild?.members.fetch(msg3.author.id);
        expect(fetched?.timeout).toHaveBeenCalledWith(28 * 24 * 60 * 60 * 1000);
    });

    it('跨頻道洗版的 sendReport 應包含所有觸發頻道', async () => {
        const msg1 = mockMessageFactory('CrossChannel');
        const msg2 = mockMessageFactory('CrossChannel');
        const msg3 = mockMessageFactory('CrossChannel');

        msg1.channelId = 'channel_A';
        msg2.channelId = 'channel_B';
        msg3.channelId = 'channel_C';

        await patrolExecute(msg1, mockClient);
        jest.advanceTimersByTime(1100);
        await patrolExecute(msg2, mockClient);
        jest.advanceTimersByTime(1100);
        await patrolExecute(msg3, mockClient);

        expect(report.sendReport).toHaveBeenCalledWith(
            mockClient,
            expect.objectContaining({
                guildId: 'test_guild_123',
                channelIds: expect.arrayContaining(['channel_A', 'channel_B', 'channel_C']),
                content: 'CrossChannel',
                reason: expect.stringContaining('跨頻道發送重複訊息，共 3 個頻道'),
            }),
        );
    });

    it('具有管理員權限的使用者不應被偵測', async () => {
        const msg1 = mockMessageFactory('Spam', { privileged: true });
        const msg2 = mockMessageFactory('Spam', { privileged: true });
        const msg3 = mockMessageFactory('Spam', { privileged: true });

        msg1.channelId = 'channel_1';
        msg2.channelId = 'channel_2';
        msg3.channelId = 'channel_3';

        await patrolExecute(msg1, mockClient);
        await patrolExecute(msg2, mockClient);
        await patrolExecute(msg3, mockClient);

        // 管理員豁免，不應觸發任何處罰
        expect(db.updateUserStars).not.toHaveBeenCalled();
        expect(report.sendReport).not.toHaveBeenCalled();
    });

    it('持有豁免身分組的使用者不應被偵測', async () => {
        // 使用預設在 mock 裡提供的值
        const exemptRoleId = 'admin_role_id';
        const msg1 = mockMessageFactory('Spam', { roleId: exemptRoleId });
        const msg2 = mockMessageFactory('Spam', { roleId: exemptRoleId });
        const msg3 = mockMessageFactory('Spam', { roleId: exemptRoleId });

        msg1.channelId = 'channel_1';
        msg2.channelId = 'channel_2';
        msg3.channelId = 'channel_3';

        await patrolExecute(msg1, mockClient);
        await patrolExecute(msg2, mockClient);
        await patrolExecute(msg3, mockClient);

        expect(db.updateUserStars).not.toHaveBeenCalled();
        expect(report.sendReport).not.toHaveBeenCalled();
    });

    it('持有豁免使用者清單 (白名單) 的不應被偵測', async () => {
        // 使用預設在 mock 裡提供的值
        const exemptUserId = 'whitelist_user_id';
        const msg1 = mockMessageFactory('Spam');
        msg1.author.id = exemptUserId;
        const msg2 = mockMessageFactory('Spam');
        msg2.author.id = exemptUserId;
        const msg3 = mockMessageFactory('Spam');
        msg3.author.id = exemptUserId;

        msg1.channelId = 'channel_1';
        msg2.channelId = 'channel_2';
        msg3.channelId = 'channel_3';

        await patrolExecute(msg1, mockClient);
        await patrolExecute(msg2, mockClient);
        await patrolExecute(msg3, mockClient);

        expect(db.updateUserStars).not.toHaveBeenCalled();
        expect(report.sendReport).not.toHaveBeenCalled();
    });

    it('IME 去重：同頻道 500ms 內同內容應被忽略、不計入水位', async () => {
        // 模擬輸入法在同一頻道極短時間內重送同一則訊息
        const msg1 = mockMessageFactory('你好嗎朋友們');
        const msg2 = mockMessageFactory('你好嗎朋友們');

        // 確保兩則在同一頻道
        msg1.channelId = 'same_channel';
        msg2.channelId = 'same_channel';

        // msg2 的 createdTimestamp 設定為比 msg1 晚 200ms (小於 IME_DEDUP_MS = 500ms)
        (msg2 as any).createdTimestamp = msg1.createdTimestamp + 200;

        await patrolExecute(msg1, mockClient);
        await patrolExecute(msg2, mockClient);

        // msg2 應被 IME 去重攔截，等同只收到 1 則訊息，不觸發處罰
        expect(db.updateUserStars).not.toHaveBeenCalled();
    });

    it('IME 去重不應攔截跨頻道訊息：避免與 API 異常偵測衝突', async () => {
        // 同一人 500ms 內在不同頻道送出一樣的內容（不應被 IME 去重吃掉）
        const msg1 = mockMessageFactory('This is cross channel content');
        const msg2 = mockMessageFactory('This is cross channel content');

        msg1.channelId = 'channel_A';
        msg2.channelId = 'channel_B';
        (msg2 as any).createdTimestamp = msg1.createdTimestamp + 100;

        await patrolExecute(msg1, mockClient);
        await patrolExecute(msg2, mockClient);

        // 跨頻道不該被 IME 去重擋掉，應觸發 API 異常偵測 → 4 星
        expect(db.updateUserStars).toHaveBeenCalledWith(msg1.author.id, 4);
    });

    it('短訊息跨頻道豁免：< 10 字元的訊息不觸發慢速跨頻道偵測', async () => {
        // "哈囉" = 2 字元，應被短訊息豁免機制跳過跨頻道偵測
        const msg1 = mockMessageFactory('哈囉');
        const msg2 = mockMessageFactory('哈囉');
        const msg3 = mockMessageFactory('哈囉');

        msg1.channelId = 'channel_1';
        msg2.channelId = 'channel_2';
        msg3.channelId = 'channel_3';

        await patrolExecute(msg1, mockClient);
        jest.advanceTimersByTime(1100);
        await patrolExecute(msg2, mockClient);
        jest.advanceTimersByTime(1100);
        await patrolExecute(msg3, mockClient);

        // 短訊息不計入慢速跨頻道偵測，不應觸發處罰
        expect(db.updateUserStars).not.toHaveBeenCalled();
    });

    it('API 異常偵測：1 秒內於兩個不同頻道發送相同內容應立即觸發 4 星', async () => {
        const msg1 = mockMessageFactory('This is a suspicious message');
        const msg2 = mockMessageFactory('This is a suspicious message');

        msg1.channelId = 'channel_X';
        msg2.channelId = 'channel_Y';

        await patrolExecute(msg1, mockClient);
        // 不推進時間 (Date.now() 不變)，模擬 API 在 1 秒內同時發送
        await patrolExecute(msg2, mockClient);

        // 應觸發 API 異常偵測，直接升至 4 星
        expect(db.updateUserStars).toHaveBeenCalledWith(msg1.author.id, 4);
    });

    it('空內容/純空白訊息應被忽略', async () => {
        const msg1 = mockMessageFactory('   ');
        const msg2 = mockMessageFactory('   ');
        const msg3 = mockMessageFactory('   ');

        await patrolExecute(msg1, mockClient);
        await patrolExecute(msg2, mockClient);
        await patrolExecute(msg3, mockClient);

        // contentHash 經 replace(/\s+/g, '') 後為空字串，直接 return
        expect(db.updateUserStars).not.toHaveBeenCalled();
    });

    it('水位自然消退：間隔足夠長的訊息不應觸發', async () => {
        // 每 30 秒送一則相同訊息，漏桶漏水量 = 30s * 5/s = 150，遠大於增加量 45
        const msg1 = mockMessageFactory('Same content repeated');
        await patrolExecute(msg1, mockClient);

        jest.advanceTimersByTime(30000);
        const msg2 = mockMessageFactory('Same content repeated');
        await patrolExecute(msg2, mockClient);

        jest.advanceTimersByTime(30000);
        const msg3 = mockMessageFactory('Same content repeated');
        await patrolExecute(msg3, mockClient);

        // 水位早已歸零，不應觸發
        expect(db.updateUserStars).not.toHaveBeenCalled();
    });

    it('累進式處罰：多次快速洗版應逐步累加星數', async () => {
        // 第一輪洗版 → 0⮕1 星
        for (let i = 0; i < 3; i++) {
            const msg = mockMessageFactory('First round spam content');
            await patrolExecute(msg, mockClient);
        }
        expect(db.updateUserStars).toHaveBeenCalledWith(
            expect.any(String), 1
        );

        // 第二輪洗版 → 1⮕2 星
        jest.advanceTimersByTime(5000);
        for (let i = 0; i < 3; i++) {
            const msg = mockMessageFactory('Second round spam content');
            await patrolExecute(msg, mockClient);
        }
        expect(db.updateUserStars).toHaveBeenCalledWith(
            expect.any(String), 2
        );
    });

    it('大量隨機內容洗版應擷取最後 5 則不重複訊息作為樣本', async () => {
        // 需建構 msgCount >= 4 且 maxCount < 3 的情境（每則內容都不同）
        // 每則不同內容 +10 水位，200ms 間隔漏水約 1，需 12 則以確保淨水位 > 100
        const uniqueMessages = [
            'Random message A - unique',
            'Random message B - unique',
            'Random message C - unique',
            'Random message D - unique',
            'Random message E - unique',
            'Random message F - unique',
            'Random message G - unique',
            'Random message H - unique',
            'Random message I - unique',
            'Random message J - unique',
            'Random message K - unique',
            'Random message L - unique',
        ];

        for (const content of uniqueMessages) {
            const msg = mockMessageFactory(content);
            jest.advanceTimersByTime(200);
            await patrolExecute(msg, mockClient);
        }

        expect(report.sendReport).toHaveBeenCalledWith(
            mockClient,
            expect.objectContaining({
                // 應包含多行內容（以 \n 分隔），而非單一重複訊息
                content: expect.stringContaining('\n'),
            }),
        );
    });
});

describe('maskMaliciousContent', () => {
    it('應正確遮蔽 HTTP/HTTPS 連結', () => {
        const text = 'Look at this: http://example.com/gift/50 and https://youtube.com/watch?v=12345';
        const masked = report.maskMaliciousContent(text);

        expect(masked).toContain('http://exa***.com/g***50');
        expect(masked).toContain('https://you***.com/w***45');
    });

    it('應優雅處理短網址', () => {
        expect(report.maskMaliciousContent('http://a.bc')).toBe('http://***');
    });
});
