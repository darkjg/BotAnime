const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getLinkFixEnabled, setLinkFixEnabled } = require('../services/db');
const { autoCleanupReply } = require('../ephemeral');

const data = new SlashCommandBuilder()
	.setName('link-fix')
	.setDescription('Activa/desactiva que el bot arregle los embeds rotos de links de X/Twitter')
	.addStringOption((option) =>
		option
			.setName('estado')
			.setDescription('Activar o desactivar')
			.setRequired(true)
			.addChoices({ name: 'Activar', value: 'on' }, { name: 'Desactivar', value: 'off' }),
	)
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function execute(interaction) {
	const estado = interaction.options.getString('estado', true);
	setLinkFixEnabled(interaction.guildId, estado === 'on');

	const activo = getLinkFixEnabled(interaction.guildId);
	const nota = activo
		? ' Necesito los permisos de "Gestionar mensajes" y, para reenviar con el nombre de quien lo escribió, "Gestionar webhooks".'
		: '';
	await interaction.reply({
		content: `Listo, arreglo de links de X/Twitter **${activo ? 'activado' : 'desactivado'}** en este servidor.${nota}`,
		ephemeral: true,
	});
	autoCleanupReply(interaction);
}

module.exports = { data, execute };
