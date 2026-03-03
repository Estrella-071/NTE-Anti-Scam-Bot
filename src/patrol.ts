import { Client, Message } from 'discord.js';
import { getUserRecord, updateUserStars, getGuildSetting } from './db';
import { sendReport } from './report';

const BUCKET_CAPACITY = 100;
const LEAK_RATE_PER_SEC = 5;
const SLOW_TRACK_EXPIRY_MS = 60 * 60 * 1000;
const MAX_CONTENT_LENGTH = 500;

const TIMEOUT_TIERS_MS = [0, 5, 15, 60].map((m) => m * 60 * 1000);
const BAN_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
const IME_DEDUP_MS = 500;
const MIN_SLOW_CONTENT_LEN = 10;



interface LeakyBucket {
    waterLevel: number;
    lastUpdated: number;
    lastContent: string;
    messageHistory: { id: string; channelId: string; timestamp: number; content: string }[];
}

// IME 去重紀錄：防止注音/倉頡等輸入法按 Enter 確認字元時，Discord 重複送出同一則訊息
const lastSeen = new Map<string, { hash: string; ts: number; channelId: string }>();

interface Fingerprint {
    content: string;
    channels: Map<string, { id: string; ts: number }>; // channelId → { messageId, timestamp }
    expiresAt: number;
}

const hotBuckets = new Map<string, LeakyBucket>();
const slowTrackers = new Map<string, Fingerprint>();

// 測試用：清除模組內部狀態
export const _resetStateForTest = () => {
    lastSeen.clear();
    hotBuckets.clear();
    slowTrackers.clear();
};

const leakWater = (bucket: LeakyBucket, now: number) => {
    const leaked = ((now - bucket.lastUpdated) / 1000) * LEAK_RATE_PER_SEC;
    bucket.waterLevel = Math.max(0, bucket.waterLevel - leaked);
    bucket.lastUpdated = now;
    if (bucket.waterLevel === 0) bucket.messageHistory = [];
};

setInterval(() => {
    const now = Date.now();
    for (const [userId, bucket] of hotBuckets.entries()) {
        leakWater(bucket, now);
        if (bucket.waterLevel === 0) hotBuckets.delete(userId);
    }
    for (const [userId, fp] of slowTrackers.entries()) {
        if (fp.expiresAt <= now) slowTrackers.delete(userId);
    }
}, 10 * 60 * 1000);

const extractChannelIds = (messages: { id: string; channelId: string }[]): string[] =>
    [...new Set(messages.map((m) => m.channelId))];

const formatDate = (date: Date): string => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${y}/${m}/${d} ${h}:${min}`;
};

export const patrolExecute = async (message: Message, client: Client) => {
    const userId = message.author.id;
    const now = Date.now();

    if (!message.guild || message.member && (
        message.member.permissions.has('Administrator') ||
        message.member.permissions.has('ManageMessages')
    )) return;

    const guildSetting = await getGuildSetting(message.guild.id);
    const ignoredUsers = new Set((guildSetting?.ignored_users || '').split(',').filter(Boolean));
    const ignoredRoles = new Set((guildSetting?.ignored_roles || '').split(',').filter(Boolean));

    if (ignoredUsers.has(userId)) return;
    if (message.member?.roles.cache.some((role) => ignoredRoles.has(role.id))) return;

    const contentHash = message.content
        .slice(0, MAX_CONTENT_LENGTH)
        .toLowerCase()
        .replace(/\s+/g, '');

    if (!contentHash) return;

    // IME 去重：同頻道 500ms 內重複內容跳過（輸入法連按 Enter）
    // 不擋跨頻道，那邊交給 API 異常偵測處理
    const msgTs = message.createdTimestamp;
    const prev = lastSeen.get(userId);
    if (prev && prev.hash === contentHash && prev.channelId === message.channelId && (msgTs - prev.ts) < IME_DEDUP_MS) {
        return;
    }
    lastSeen.set(userId, { hash: contentHash, ts: msgTs, channelId: message.channelId });

    let bucket = hotBuckets.get(userId);
    if (!bucket) {
        bucket = { waterLevel: 0, lastUpdated: now, lastContent: '', messageHistory: [] };
        hotBuckets.set(userId, bucket);
    }
    leakWater(bucket, now);

    let waterToAdd = 10;
    if (message.content.length < 5) waterToAdd -= 5;
    if (contentHash === bucket.lastContent) waterToAdd += 35;

    bucket.waterLevel += waterToAdd;
    bucket.lastContent = contentHash;
    bucket.messageHistory.push({
        id: message.id,
        channelId: message.channelId,
        timestamp: message.createdTimestamp,
        content: message.content
    });

    let isHitSlowRaid = false;
    let targetMessagesToDelete: { id: string; channelId: string }[] = [
        { id: message.id, channelId: message.channelId },
    ];

    // 短訊息豁免：過短訊息不計入慢速跨頻道偵測
    if (message.content.length >= MIN_SLOW_CONTENT_LEN) {
        let fp = slowTrackers.get(userId);
        if (!fp || fp.expiresAt <= now || fp.content !== contentHash) {
            fp = { content: contentHash, channels: new Map(), expiresAt: now + SLOW_TRACK_EXPIRY_MS };
        }

        // 偵測 API 異常：1 秒內於多個頻道發送相同內容
        for (const [chanId, info] of fp.channels.entries()) {
            if (chanId !== message.channelId && (now - info.ts) < 1000) {
                isHitSlowRaid = true;
                targetMessagesToDelete = [
                    { id: info.id, channelId: chanId },
                    { id: message.id, channelId: message.channelId }
                ];
                break;
            }
        }

        fp.channels.set(message.channelId, { id: message.id, ts: now });
        fp.expiresAt = now + SLOW_TRACK_EXPIRY_MS;
        slowTrackers.set(userId, fp);

        if (!isHitSlowRaid && fp.channels.size >= 3) {
            isHitSlowRaid = true;
            targetMessagesToDelete = Array.from(fp.channels.entries()).map(
                ([channelId, info]) => ({ id: info.id, channelId }),
            );
        }
    }

    const isHitFastRaid = !isHitSlowRaid && bucket.waterLevel >= BUCKET_CAPACITY;
    if (isHitFastRaid) {
        targetMessagesToDelete = [...bucket.messageHistory];
    }

    if (isHitFastRaid || isHitSlowRaid) {
        const dateStr = formatDate(new Date(now));
        let reasonBase = '';
        let finalContent = message.content;

        if (isHitFastRaid) {
            const firstMsgTime = bucket.messageHistory[0].timestamp;
            const timeSpanSec = Math.max(0, (message.createdTimestamp - firstMsgTime) / 1000).toFixed(1);
            const msgCount = bucket.messageHistory.length;
            reasonBase = `${dateStr} 短時間內高頻率發送訊息，${timeSpanSec} 秒內共發送了 ${msgCount} 則`;

            const contentCounts = new Map<string, number>();
            let maxCount = 0;
            let mostFrequent = '';
            for (const msg of bucket.messageHistory) {
                const count = (contentCounts.get(msg.content) || 0) + 1;
                contentCounts.set(msg.content, count);
                if (count > maxCount) {
                    maxCount = count;
                    mostFrequent = msg.content;
                }
            }

            if (maxCount < 3 && msgCount >= 4) {
                const recentUnique = Array.from(new Set(bucket.messageHistory.map((m) => m.content).reverse())).slice(0, 5).reverse();
                finalContent = recentUnique.join('\n');
            } else {
                finalContent = mostFrequent;
            }
        } else if (isHitSlowRaid) {
            const currentFp = slowTrackers.get(userId);
            const chanCount = currentFp ? currentFp.channels.size : 2;
            reasonBase = `${dateStr} 跨頻道發送重複訊息，共 ${chanCount} 個頻道`;
        }

        const reason = reasonBase;

        hotBuckets.delete(userId);
        slowTrackers.delete(userId);

        await executePunishment(userId, message, client, reason, finalContent, targetMessagesToDelete, isHitSlowRaid);
    }
};

const executePunishment = async (
    userId: string,
    triggerMessage: Message,
    client: Client,
    reason: string,
    content: string,
    messagesToDelete: { id: string; channelId: string }[],
    forceFourStars = false,
) => {
    if (!triggerMessage.guild) return;

    const record = (await getUserRecord(userId)) || { discord_id: userId, stars: 0, last_updated: Date.now() };
    const oldStars = record.stars;
    const newStars = forceFourStars ? 4 : Math.min(oldStars + 1, 4);
    await updateUserStars(userId, newStars);

    console.warn(`${triggerMessage.author.tag} 觸發警報: ${reason}。${oldStars}⮕${newStars} 星`);

    const messagesByChannel = new Map<string, string[]>();
    for (const msg of messagesToDelete) {
        if (!messagesByChannel.has(msg.channelId)) {
            messagesByChannel.set(msg.channelId, []);
        }
        messagesByChannel.get(msg.channelId)!.push(msg.id);
    }

    const member = await triggerMessage.guild.members.fetch(userId).catch(() => null);
    let actionTaken = '刪除訊息並升星 (0星初犯)';

    if (member?.manageable) {
        try {
            if (newStars === 4) {
                await member.timeout(BAN_TIMEOUT_MS);
                actionTaken = '永久禁言 (28天，待人工審核)';
            } else if (newStars > 0 && TIMEOUT_TIERS_MS[newStars] > 0) {
                await member.timeout(TIMEOUT_TIERS_MS[newStars]);
                actionTaken = `刪除訊息 + 禁言 ${TIMEOUT_TIERS_MS[newStars] / 60000} 分鐘`;
            }
        } catch (err) {
            console.error(`執行 ${newStars} 星處罰失敗`, err);
            actionTaken += ' (權限不足)';
        }
    }

    await Promise.allSettled(
        Array.from(messagesByChannel.entries()).map(async ([channelId, msgIds]) => {
            try {
                const channel = await client.channels.fetch(channelId);
                if (channel && 'bulkDelete' in channel && typeof channel.bulkDelete === 'function') {
                    await channel.bulkDelete(msgIds).catch((err: Error) => {
                        console.warn(`bulkDelete 失敗 (頻道 ${channelId}):`, err.message);
                    });
                } else if (channel?.isTextBased()) {
                    for (const id of msgIds) {
                        const fetched = await channel.messages.fetch(id).catch(() => null);
                        if (fetched) await fetched.delete().catch(() => { });
                    }
                }
            } catch (err) {
                console.warn(`批次刪除頻道 ${channelId} 訊息發生錯誤:`, err);
            }
        })
    );

    await sendReport(client, {
        guildId: triggerMessage.guild.id,
        offenderId: userId,
        offenderTag: triggerMessage.author.tag,
        avatarURL: triggerMessage.author.displayAvatarURL({ size: 64 }),
        channelIds: extractChannelIds(messagesToDelete),
        reason,
        content,
        oldStars,
        newStars,
        actionTaken,
    });
};
