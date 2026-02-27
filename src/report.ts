import {
    Client,
    TextChannel,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';

import { getGuildSetting } from './db';


export const maskMaliciousContent = (text: string): string => {
    return text.replace(
        /(https?:\/\/)([a-zA-Z0-9.-]+)(\/[^\s]*)?/g,
        (_match, protocol: string, host: string, urlPath: string | undefined) => {
            if (host.length <= 5) return protocol + '***';

            const hostParts = host.split('.');
            const tld = hostParts.pop();
            const mainHost = hostParts.join('.');

            const hiddenHost = mainHost.length > 3 ? mainHost.slice(0, 3) + '***' : '***';
            const hiddenPath =
                urlPath && urlPath.length > 5
                    ? `/${urlPath.slice(1, 2)}***${urlPath.slice(-2)}`
                    : urlPath || '';

            return `${protocol}${hiddenHost}.${tld}${hiddenPath}`;
        },
    );
};

const renderStars = (count: number): string =>
    count === 0 ? '\\_' : '⭐️'.repeat(count);

export interface ReportPayload {
    guildId: string;
    offenderId: string;
    offenderTag: string;
    avatarURL: string;
    channelIds: string[];
    reason: string;
    content: string;
    oldStars: number;
    newStars: number;
    actionTaken: string;
}

export const sendReport = async (client: Client, payload: ReportPayload): Promise<void> => {
    const guildSetting = getGuildSetting(payload.guildId);
    const reportChannelId = guildSetting?.report_channel_id;

    if (!reportChannelId) {
        console.warn(`未設定通報頻道 (Guild: ${payload.guildId})，跳過通報`);
        return;
    }

    try {
        const reportChannel = (await client.channels.fetch(reportChannelId)) as TextChannel;
        if (!reportChannel?.isTextBased()) {
            console.error('報案頻道不存在或非文字頻道');
            return;
        }

        const { offenderId, offenderTag, avatarURL, channelIds, reason, content, oldStars, newStars, actionTaken } = payload;

        const channelMentions = channelIds.map((id) => `<#${id}>`).join('、');

        const safeContent = content.length > 3500 ? content.slice(0, 3500) + '\n... (內容過長已自行截斷)' : content;

        const description = [
            `違規鑒定師： <@${offenderId}>`,
            `通緝值： ${renderStars(oldStars)}⮕${renderStars(newStars)}`,
            '',
            `觸發頻道： ${channelMentions}`,
            `違規事項： ${reason}`,
            `擷取內容：`,
            `\`\`\``,
            `${maskMaliciousContent(safeContent)}`,
            `\`\`\``,
            `懲罰方式： ${actionTaken}`,
        ].join('\n');

        const embed = new EmbedBuilder()
            .setColor(0xff4545)
            .setAuthor({
                name: `${offenderTag} (${offenderId})`,
                iconURL: avatarURL,
            })
            .setDescription(description);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`edit_${offenderId}`)
                .setLabel('編輯')
                .setStyle(ButtonStyle.Secondary),
        );

        await reportChannel.send({ embeds: [embed], components: [row] });
    } catch (error) {
        console.error('送出通報時發生錯誤', error);
    }
};
