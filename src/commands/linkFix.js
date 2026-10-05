const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getLinkFixSitesEnabled, setLinkFixSiteEnabled } = require('../services/db');
const { SITIOS_LINKFIX } = require('../linkFixService');
const { autoCleanupReply } = require('../ephemeral');

const data = new SlashCommandBuilder()
	.setName('link-fix')
	.setDescription('Activa/desactiva que el bot arregle los embeds rotos de links (X, TikTok, Instagram, Reddit...)')
	.addStringOption((option) =>
		option
			.setName('estado')
			.setDescription('Activar o desactivar')
			.setRequired(true)
			.addChoices({ name: 'Activar', value: 'on' }, { name: 'Desactivar', value: 'off' }),
	)
	.addStringOption((option) =>
		option
			.setName('sitio')
			.setDescription('Qué sitio (por defecto X/Twitter)')
			.setRequired(false)
			.addChoices({ name: 'Todos', value: 'todos' }, ...SITIOS_LINKFIX.map((sitio) => ({ name: sitio, value: sitio }))),
	)
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function execute(interaction) {
	const estado = interaction.options.getString('estado', true);
	const sitio = interaction.options.getString('sitio') ?? 'x';
	const activar = estado === 'on';

	const objetivo = sitio === 'todos' ? SITIOS_LINKFIX : [sitio];
	for (const clave of objetivo) setLinkFixSiteEnabled(interaction.guildId, clave, activar);

	const activos = getLinkFixSitesEnabled(interaction.guildId);
	const resumen = SITIOS_LINKFIX.map((clave) => `${activos.has(clave) ? '✅' : '🛑'} ${clave}`).join('\n');
	const nota = activar
		? '\nNecesito los permisos de "Gestionar mensajes" y, para reenviar con el nombre de quien lo escribió, "Gestionar webhooks".'
		: '';
	await interaction.reply({
		content: `Listo, arreglo de links de **${sitio === 'todos' ? 'todos los sitios' : sitio}** **${activar ? 'activado' : 'desactivado'}** en este servidor.${nota}\n\nEstado actual:\n${resumen}`,
		ephemeral: true,
	});
	autoCleanupReply(interaction);
}

module.exports = { data, execute };
