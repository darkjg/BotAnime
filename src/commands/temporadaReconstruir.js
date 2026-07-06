const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { rebuildSeasonTab } = require('../seasonRebuild');

const data = new SlashCommandBuilder()
	.setName('temporada-reconstruir')
	.setDescription('Borra y reconstruye la pestaña de una temporada desde cero, usando los votos guardados')
	.addStringOption((option) =>
		option
			.setName('nombre')
			.setDescription('Nombre exacto de la pestaña de la sheet a reconstruir, ej: "Verano 2026"')
			.setRequired(true),
	)
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function execute(interaction) {
	await interaction.deferReply({ ephemeral: true });

	const nombre = interaction.options.getString('nombre', true);
	console.log(`[temporada-reconstruir] reconstruyendo "${nombre}"...`);

	try {
		const { animeCount, votesApplied } = await rebuildSeasonTab(nombre);
		console.log(`[temporada-reconstruir] "${nombre}" reconstruida: ${animeCount} anime(s), ${votesApplied} voto(s) reaplicados`);
		await interaction.editReply(`Reconstruí **${nombre}** desde cero: ${animeCount} anime(s) con ${votesApplied} voto(s) reaplicados.`);
	} catch (err) {
		console.error(`[temporada-reconstruir] no pude reconstruir "${nombre}":`, err.message);
		await interaction.editReply(`No pude reconstruir "${nombre}": ${err.message}`);
	}
}

module.exports = { data, execute };
