const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { slugForCustomId } = require('./seasonLabel');

function buildAnimeEmbed(anime, { index, total } = {}) {
	const embed = new EmbedBuilder()
		.setTitle(anime.title)
		.setURL(anime.url)
		.setColor(0x2f3136);

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

	if (Number.isInteger(index) && Number.isInteger(total)) embed.setFooter({ text: `${index + 1}/${total}` });

	return embed;
}

function buildVoteRow(seasonLabel, malId, { index, total } = {}) {
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

	const navRow = new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`nav:prev:${seasonSlug}:${malId}`)
			.setLabel('⬅️ Anterior')
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(index === 0),
		new ButtonBuilder()
			.setCustomId(`nav:next:${seasonSlug}:${malId}`)
			.setLabel('Siguiente ➡️')
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(index === total - 1),
		new ButtonBuilder().setCustomId(`finish:${seasonSlug}`).setLabel('✅ Lista completada').setStyle(ButtonStyle.Success),
	);

	return [voteRow, navRow];
}

module.exports = { buildAnimeEmbed, buildVoteRow };
