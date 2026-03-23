import {
    Interaction,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    TextChannel,
    ChannelSelectMenuBuilder,
    RoleSelectMenuBuilder,
    UserSelectMenuBuilder,
    ChannelType,
} from 'discord.js';

import { updateGuildSetting, getGuildSetting, updateUserStars, getUserRecord } from './db';

const getSetupMessagePayload = async (guildId: string) => {
    const guildSetting = await getGuildSetting(guildId);

    const embed = new EmbedBuilder()
        .setTitle('巡哨鼠鼠管理控制台')
        .setColor(0x2b2d31)
        .setDescription('請在下方選單分別設定對應的項目，選單支援多選，選擇完畢後會自動儲存。')
        .addFields(
            { name: '通報頻道', value: '選擇接收洗版通報與處罰紀錄的文字頻道。' },
            { name: '身分組白名單 (包含該身分組下所有成員)', value: '選擇不受防禦系統限制的身分組。' },
            { name: '成員白名單', value: '選擇不受防禦系統限制的個別使用者。' }
        );

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('setup_channel')
        .setPlaceholder('選擇通報頻道​​​​​')
        .setChannelTypes(ChannelType.GuildText);

    if (guildSetting?.report_channel_id) {
        channelSelect.setDefaultChannels(guildSetting.report_channel_id);
    }

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('setup_roles')
        .setPlaceholder('選擇身分組白名單 (可多選)​​​​​')
        .setMinValues(0)
        .setMaxValues(15);

    const ignoredRoles = (guildSetting?.ignored_roles || '').split(',').filter(Boolean);
    if (ignoredRoles.length > 0) {
        // @ts-ignore
        roleSelect.setDefaultRoles(...ignoredRoles);
    }

    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('setup_users')
        .setPlaceholder('選擇成員白名單 (可多選)​​​​​')
        .setMinValues(0)
        .setMaxValues(15);

    const ignoredUsers = (guildSetting?.ignored_users || '').split(',').filter(Boolean);
    if (ignoredUsers.length > 0) {
        // @ts-ignore
        userSelect.setDefaultUsers(...ignoredUsers);
    }

    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect),
            new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect),
            new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect),
        ],
        ephemeral: true,
    };
};

export const handleInteraction = async (interaction: Interaction) => {
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'setup') {
            if (!interaction.guildId) return;
            try {
                await interaction.deferReply({ ephemeral: true });
                const payload = await getSetupMessagePayload(interaction.guildId);
                await interaction.editReply(payload);
            } catch (err) {
                console.error('執行 /setup 時捕捉到錯誤:', err);
                await interaction.editReply({ content: '資料庫讀取失敗或發生非預期錯誤，請稍後重試。' }).catch(() => {});
            }
        } else if (interaction.commandName === 'reset') {
            try {
                await interaction.deferReply({ ephemeral: true });
                const targetUser = interaction.options.getUser('user', true);
                const record = await getUserRecord(targetUser.id);
                const oldStars = record?.stars ?? 0;

                if (oldStars === 0) {
                    await interaction.editReply({ content: `<@${targetUser.id}> 目前沒有通緝值，不需要清空。` });
                    return;
                }

                await updateUserStars(targetUser.id, 0);
                console.log(`${interaction.user.tag} 將 ${targetUser.tag} 的通緝值從 ${oldStars} 星清空為 0 星`);
                await interaction.editReply({ content: `已將 <@${targetUser.id}> 的通緝值從 ${oldStars} ⭐ 清空為 0 ⭐` });
            } catch (err) {
                console.error('執行 /reset 時捕捉到錯誤:', err);
                await interaction.editReply({ content: '執行失敗，請檢查資料庫連線或相關權限。' }).catch(() => {});
            }
        }
        return;
    }

    if (interaction.isAnySelectMenu()) {
        if (!interaction.guildId || !interaction.member) return;

        const permissions = typeof interaction.member.permissions === 'string' ? null : interaction.member.permissions;
        if (!permissions || (!permissions.has('Administrator') && !permissions.has('ModerateMembers'))) {
            await interaction.reply({ content: '權限不足。', ephemeral: true }).catch(() => { });
            return;
        }

        try {
            if (interaction.customId === 'setup_channel') {
                const channelId = interaction.values[0];
                await updateGuildSetting(interaction.guildId, 'report_channel_id', channelId);
            } else if (interaction.customId === 'setup_roles') {
                const rolesStr = interaction.values.join(',');
                await updateGuildSetting(interaction.guildId, 'ignored_roles', rolesStr);
            } else if (interaction.customId === 'setup_users') {
                const usersStr = interaction.values.join(',');
                await updateGuildSetting(interaction.guildId, 'ignored_users', usersStr);
            }
            await interaction.update(await getSetupMessagePayload(interaction.guildId));
        } catch (err) {
            console.error('儲存設定失敗', err);
            await interaction.reply({ content: '設定儲存失敗，請稍後重試。', ephemeral: true });
        }
        return;
    }

    if (!interaction.isButton()) return;

    const { customId, guild, member } = interaction;
    if (!guild || !member) return;

    const permissions = typeof member.permissions === 'string' ? null : member.permissions;
    if (permissions && !permissions.has('Administrator') && !permissions.has('ModerateMembers')) {
        await interaction.deferUpdate().catch(() => { });
        return;
    }

    const parts = customId.split('_');
    const action = parts[0];

    try {
        if (action === 'edit') {
            const targetId = parts[1];
            const msgId = interaction.message.id;
            const channelId = interaction.message.channelId;

            const editRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`chooseuntimeout_${targetId}_${msgId}_${channelId}`)
                    .setLabel('解除禁言')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('cancelaction')
                    .setLabel('取消')
                    .setStyle(ButtonStyle.Secondary),
            );

            await interaction.reply({
                content: `請選擇要對 <@${targetId}> 執行的處置：`,
                components: [editRow],
                ephemeral: true,
            });
            return;
        }

        if (action === 'chooseuntimeout') {
            const targetId = parts[1];
            const msgId = parts[2];
            const channelId = parts[3];

            const confirmCustomId = `confirmuntimeout_${targetId}_${msgId}_${channelId}`;
            const labelText = '確認解除禁言';
            const confirmStyle = ButtonStyle.Success;

            const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(confirmCustomId)
                    .setLabel(labelText)
                    .setStyle(confirmStyle),
                new ButtonBuilder()
                    .setCustomId('cancelaction')
                    .setLabel('取消')
                    .setStyle(ButtonStyle.Secondary),
            );

            await interaction.update({
                content: `確定要將 <@${targetId}> 解除禁言嗎？\n此操作無法自動撤銷。`,
                components: [confirmRow],
            });
            return;
        }

        if (action === 'confirmuntimeout') {
            const targetId = parts[1];
            const origMsgId = parts[2];
            const origChannelId = parts[3];

            const targetMember = await guild.members.fetch(targetId).catch(() => null);
            if (!targetMember) {
                await interaction.update({ content: '找不到該使用者，可能已離開伺服器。', components: [] });
                return;
            }

            await targetMember.timeout(null, '管理員透過巡哨鼠鼠執行解除禁言');
            console.log(`${targetId} 被 ${interaction.user.tag} 解除禁言`);

            const successText = '已執行解除禁言。';
            await interaction.update({ content: successText, components: [] });

            const resultText = `處理結果： 已解除 <@${targetId}> 的禁言（由 <@${interaction.user.id}> 操作）`;

            try {
                const origChannel = await guild.client.channels.fetch(origChannelId) as TextChannel;
                const origMsg = await origChannel.messages.fetch(origMsgId);
                const original = origMsg.embeds[0];
                if (!original) return;

                const originalDesc = original.description || '';
                const newDesc = originalDesc.replace(
                    /懲罰方式：.*/,
                    resultText
                );

                const updatedEmbed = EmbedBuilder.from(original).setDescription(newDesc);

                await origMsg.edit({
                    embeds: [updatedEmbed],
                    components: [],
                });
            } catch (err) {
                console.error('更新通報 Embed 失敗', err);
            }
            return;
        }

        if (action === 'cancelaction') {
            await interaction.update({ content: '已取消操作。', components: [] });
            return;
        }
    } catch (error) {
        console.error('執行處分按鈕時發生錯誤', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction
                .reply({ content: '執行失敗，可能是權限不足或對方身分組較高。', ephemeral: true })
                .catch(() => { });
        }
    }
};


