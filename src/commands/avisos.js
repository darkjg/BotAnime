const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { setNotificationChannel } = require('../services/db');

const data = new SlashCommandBuilder()
	.setName('avisos-canal')
	.setDescription('Configura este canal para los avisos semanales de nuevo capítulo')
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function execute(interaction) {
	setNotificationChannel({ guildId: interaction.guildId, channelId: interaction.channelId });
	console.log(`[avisos-canal] canal de avisos del guild ${interaction.guildId} configurado a #${interaction.channel.name}`);
	await interaction.reply(`Listo, a partir de ahora los avisos de nuevo capítulo se van a publicar en <#${interaction.channelId}>.`);
}

module.exports = { data, execute };
