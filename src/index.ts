// dotenv 必須在所有其他模組載入前執行，否則環境變數讀不到
import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, Partials, Message, Events } from 'discord.js';
import { initDB, runWeeklyDecay } from './db';
import { patrolExecute } from './patrol';
import { handleInteraction } from './interaction';

const BOT_TOKEN = process.env.BOT_TOKEN || '';
if (!BOT_TOKEN) {
    console.error('未設定 BOT_TOKEN，機器人無法啟動');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

initDB();

// 每 12 小時執行一次降星排程
setInterval(() => {
    try {
        runWeeklyDecay();
    } catch (err) {
        console.error('降星排程失敗', err);
    }
}, 12 * 60 * 60 * 1000);

client.once(Events.ClientReady, async () => {
    console.log(`巡哨鼠鼠已上線：${client.user?.tag}`);

    try {
        await client.application?.commands.set([
            {
                name: 'setup',
                description: '開啟巡哨鼠鼠管理介面 (設定通報頻道與白名單)',
                defaultMemberPermissions: 'Administrator',
            }
        ]);
        console.log('✅ 應用程式斜線指令同步完成');
    } catch (err) {
        console.error('❌ 指令同步失敗:', err);
    }
});

client.on('messageCreate', async (message: Message) => {
    if (message.author.bot || !message.guild) return;
    try {
        await patrolExecute(message, client);
    } catch (err) {
        console.error('巡邏引擎錯誤', err);
    }
});

client.on('interactionCreate', (interaction) => handleInteraction(interaction));

client.login(BOT_TOKEN).catch((err) => {
    console.error('登入失敗', err);
    process.exit(1);
});

// 攔截系統底層的未預期錯誤，防止機器人因單一非同步失敗而整機斷線
process.on('unhandledRejection', (reason, promise) => {
    console.error('嚴重的全域非同步錯誤被攔截 (Unhandled Rejection) :', promise, '原因:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('嚴重的全域例外崩潰被攔截 (Uncaught Exception) :', err);
});
