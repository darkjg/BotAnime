const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { slugForCustomId } = require('./seasonLabel');

const VOTE_STATE_COLOR = { verde: 0x57f287, naranja: 0xe67e22 };

function buildAnimeEmbed(anime, { voteState, progress } = {}) {
	const embed = new EmbedBuilder()
		.setTitle(anime.title)
		.setURL(anime.url)
		.setColor(VOTE_STATE_COLOR[voteState] ?? 0x2f3136);

	if (anime.imageUrl) embed.setImage(anime.imageUrl);
	if (anime.synopsis) {
		const synopsis = anime.synopsis.length > 500 ? `${anime.synopsis.slice(0, 500)}…` : anime.synopsis;
		embed.setDescription(synopsis);
	}

	embed.addFields(
		{ name: 'Episodios', value: anime.episodes ? String(anime.episodes) : 'Desconocido', inline: true },
		{ name: 'Día de emisión', value: anime.broadcastDay ?? 'Desconocido', inline: true },
		{ name: 'Estudio', value: anime.studios || 'Desconocido', inline: true },
	);

	if (progress?.length > 0) {
		const lines = [...progress]
			.sort((a, b) => b.episodesWatched - a.episodesWatched)
			.map((p) => `**${p.displayName}**: cap. ${p.episodesWatched}`)
			.join('\n');
		embed.addFields({ name: '📺 Progreso', value: lines });
	}

	return embed;
}

// Se usa tanto en el hilo de voto como en el aviso de "nuevo episodio disponible" del scheduler, así
// que vive aparte de buildVoteRow.
function buildEpisodeButtonRow(seasonLabel, malId) {
	const seasonSlug = slugForCustomId(seasonLabel);
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId(`episodepick:${seasonSlug}:${malId}`).setLabel('📺 Actualizar capítulo').setStyle(ButtonStyle.Secondary),
	);
}

function buildVoteRow(seasonLabel, malId, { voteState } = {}) {
	const seasonSlug = slugForCustomId(seasonLabel);
	const voteRow = new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`vote:verde:${seasonSlug}:${malId}`)
			.setLabel('Lo veré')
			.setStyle(ButtonStyle.Success),
		new ButtonBuilder()
			.setCustomId(`vote:naranja:${seasonSlug}:${malId}`)
			.setLabel('Le doy una oportunidad')
			.setStyle(ButtonStyle.Primary),
		new ButtonBuilder()
			.setCustomId(`vote:rojo:${seasonSlug}:${malId}`)
			.setLabel('No lo veré')
			.setStyle(ButtonStyle.Danger),
		new ButtonBuilder()
			.setCustomId(`trailer:${malId}`)
			.setLabel('Trailer')
			.setStyle(ButtonStyle.Secondary),
	);

	// Siempre visible, no depende del voto (se puede llevar la cuenta de capítulos aunque el voto sea
	// rojo o todavía no se haya votado). Abre un selector de usuarios en vez de actuar solo sobre quien
	// aprieta el botón, porque una misma persona suele actualizar el capítulo de todo el grupo a la vez.
	const episodeRow = buildEpisodeButtonRow(seasonLabel, malId);

	if (!voteState) return [voteRow, episodeRow];

	const undoRow = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId(`undovote:${seasonSlug}:${malId}`).setLabel('↩️ Deshacer mi voto').setStyle(ButtonStyle.Secondary),
	);
	return [voteRow, episodeRow, undoRow];
}

module.exports = { buildAnimeEmbed, buildVoteRow, buildEpisodeButtonRow };
