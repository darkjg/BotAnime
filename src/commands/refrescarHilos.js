const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getActiveSeason, getAnimeForSeason, getAv1ForumThread, getVoteState, getWatchersWithProgress } = require('../services/db');
const { buildAnimeEmbed, buildVoteRow } = require('../components');
const { autoCleanupReply } = require('../ephemeral');

const data = new SlashCommandBuilder()
	.setName('refrescar-hilos')
	.setDescription('Actualiza los embeds del foro con quién ve cada anime y por qué capítulo va')
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

// Los hilos publicados antes de que existiera el campo "Progreso" (o votados/actualizados por gente
// que no disparó un refresco en su momento) se quedan con el embed viejo hasta que alguien vuelva a
// votar o actualizar su capítulo. Este comando fuerza ese refresco para todos los animes de la
// temporada activa de una sola vez.
async function execute(interaction) {
	await interaction.deferReply({ ephemeral: true });

	const seasonLabel = getActiveSeason(interaction.guildId);
	if (!seasonLabel) {
		await interaction.editReply('No hay una temporada activa en este servidor.');
		autoCleanupReply(interaction);
		return;
	}

	const tracked = getAnimeForSeason(seasonLabel).filter((a) => a.guildId === interaction.guildId);
	let updated = 0;
	let skipped = 0;

	for (const anime of tracked) {
		const threadId = getAv1ForumThread({ guildId: interaction.guildId, seasonLabel, malId: anime.malId });
		if (!threadId) {
			skipped += 1;
			continue;
		}

		try {
			const thread = await interaction.client.channels.fetch(threadId);
			const message = await thread.messages.fetch(threadId); // el post inicial comparte id con el hilo
			const voteState = getVoteState({ seasonLabel, malId: anime.malId });
			const progress = getWatchersWithProgress({ seasonLabel, malId: anime.malId });
			await message.edit({
				embeds: [buildAnimeEmbed(anime, { voteState, progress })],
				components: buildVoteRow(seasonLabel, anime.malId, { voteState }),
			});
			updated += 1;
		} catch (err) {
			console.error(`[refrescar-hilos] no pude actualizar "${anime.title}":`, err.message);
			skipped += 1;
		}
	}

	console.log(`[refrescar-hilos] "${seasonLabel}": ${updated} hilo(s) actualizado(s), ${skipped} salteado(s)`);
	await interaction.editReply(`Listo. Actualicé ${updated} hilo(s) de **${seasonLabel}**.${skipped > 0 ? ` Salteados: ${skipped}.` : ''}`);
	autoCleanupReply(interaction);
}

module.exports = { data, execute };
