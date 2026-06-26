const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { getTrailers, hasPrequel } = require('./services/jikan');
const { setVote, clearVote } = require('./services/sheets');
const { recordVote, removeVote, getVoteState } = require('./services/db');
const { getAnime, rememberAnime, getSeasonLabel, getSeasonOrder } = require('./seasonCache');
const { buildAnimeEmbed, buildVoteRow } = require('./components');
const { handleSeasonSelect, handleSeasonConfirm } = require('./commands/temporadaShared');

const VOTE_ROLE_ID = process.env.VOTE_ROLE_ID;

async function handleVoteButton(interaction, voteType, seasonSlug, malId) {
	if (VOTE_ROLE_ID && !interaction.member.roles.cache.has(VOTE_ROLE_ID)) {
		await interaction.reply({ content: 'No tienes el rol necesario para votar.', ephemeral: true });
		return;
	}

	const anime = getAnime(Number(malId));
	if (!anime) {
		await interaction.reply({
			content: 'No encuentro este anime en memoria (¿se reinició el bot?). Vuelve a correr /temporada.',
			ephemeral: true,
		});
		return;
	}

	const seasonLabel = getSeasonLabel(seasonSlug);
	if (!seasonLabel) {
		await interaction.reply({
			content: 'No encuentro la temporada en memoria (¿se reinició el bot?). Vuelve a correr /temporada.',
			ephemeral: true,
		});
		return;
	}

	await interaction.deferReply({ ephemeral: true });

	const username = interaction.member.displayName;
	const animeForSheet =
		voteType === 'rojo' ? anime : { ...anime, isSequel: anime.isSequel || (await hasPrequel(anime.malId)) };
	if (voteType !== 'rojo') rememberAnime(animeForSheet);
	await setVote(seasonLabel, username, animeForSheet, voteType);

	if (voteType === 'rojo') {
		removeVote({ seasonLabel, malId: anime.malId, discordId: interaction.member.id });
	} else {
		recordVote({ seasonLabel, malId: anime.malId, discordId: interaction.member.id, displayName: username, voteType });
	}

	console.log(`[interactions] voto "${voteType}" de ${username} para "${anime.title}" (${seasonLabel})`);

	const confirmation = voteType === 'rojo' ? `Anotado: no verás **${anime.title}**.` : `Tu voto para **${anime.title}** se guardó.`;
	await interaction.editReply(confirmation);

	setTimeout(() => {
		interaction.deleteReply().catch(() => {});
	}, 1_000);
}

async function handleUndoVoteButton(interaction, seasonSlug, malId) {
	if (VOTE_ROLE_ID && !interaction.member.roles.cache.has(VOTE_ROLE_ID)) {
		await interaction.reply({ content: 'No tienes el rol necesario para votar.', ephemeral: true });
		return;
	}

	const anime = getAnime(Number(malId));
	const seasonLabel = getSeasonLabel(seasonSlug);
	if (!anime || !seasonLabel) {
		await interaction.reply({
			content: 'No encuentro esto en memoria (¿se reinició el bot?). Vuelve a correr /temporada.',
			ephemeral: true,
		});
		return;
	}

	await interaction.deferReply({ ephemeral: true });

	const username = interaction.member.displayName;
	const cleared = await clearVote(seasonLabel, username, anime);
	removeVote({ seasonLabel, malId: anime.malId, discordId: interaction.member.id });

	console.log(`[interactions] deshacer voto de ${username} para "${anime.title}" (${seasonLabel}): ${cleared ? 'borrado' : 'no había voto'}`);

	const confirmation = cleared
		? `Borré tu voto para **${anime.title}**.`
		: `No tenías un voto guardado para **${anime.title}**.`;
	await interaction.editReply(confirmation);

	setTimeout(() => {
		interaction.deleteReply().catch(() => {});
	}, 1_000);
}

async function handleNavButton(interaction, direction, seasonSlug, malId) {
	const order = getSeasonOrder(seasonSlug);
	const seasonLabel = getSeasonLabel(seasonSlug);
	if (!order || !seasonLabel) {
		await interaction.reply({
			content: 'No encuentro esta temporada en memoria (¿se reinició el bot?). Vuelve a correr /temporada.',
			ephemeral: true,
		});
		return;
	}

	const currentIndex = order.indexOf(Number(malId));
	const newIndex = direction === 'prev' ? Math.max(0, currentIndex - 1) : Math.min(order.length - 1, currentIndex + 1);
	const newAnime = getAnime(order[newIndex]);
	if (!newAnime) {
		await interaction.reply({
			content: 'No encuentro ese anime en memoria (¿se reinició el bot?). Vuelve a correr /temporada.',
			ephemeral: true,
		});
		return;
	}

	await interaction.deferUpdate();
	const voteState = getVoteState({ seasonLabel, malId: newAnime.malId });
	console.log(`[interactions] nav "${direction}" en ${seasonLabel}: ahora muestra "${newAnime.title}" (${newIndex + 1}/${order.length})`);
	await interaction.editReply({
		embeds: [buildAnimeEmbed(newAnime, { index: newIndex, total: order.length, voteState })],
		components: buildVoteRow(seasonLabel, newAnime.malId, { index: newIndex, total: order.length, voteState }),
	});
}

async function handleFinishButton(interaction, seasonSlug) {
	if (VOTE_ROLE_ID && !interaction.member.roles.cache.has(VOTE_ROLE_ID)) {
		await interaction.reply({ content: 'No tienes el rol necesario para cerrar la votación.', ephemeral: true });
		return;
	}

	const seasonLabel = getSeasonLabel(seasonSlug) ?? 'esta temporada';
	console.log(`[interactions] "${seasonLabel}" marcada como completa por ${interaction.member.displayName}`);
	await interaction.update({
		content: `Temporada **${seasonLabel}** completa. ¡Gracias por votar!`,
		embeds: [],
		components: [],
	});
}

async function handleTrailerButton(interaction, malId) {
	await interaction.deferReply({ ephemeral: true });
	const anime = getAnime(Number(malId));
	const trailers = await getTrailers(Number(malId));

	if (trailers.length === 0) {
		await interaction.editReply(`No hay trailer disponible para **${anime?.title ?? 'este anime'}**.`);
		return;
	}

	if (trailers.length === 1) {
		await interaction.editReply(`${trailers[0].title}: ${trailers[0].url}`);
		return;
	}

	const select = new StringSelectMenuBuilder()
		.setCustomId(`trailerselect:${malId}`)
		.setPlaceholder('Elige un trailer')
		.addOptions(
			trailers.slice(0, 25).map((trailer, index) => ({
				label: trailer.title.slice(0, 100) || `Trailer ${index + 1}`,
				value: String(index),
			})),
		);

	interaction.client.trailerCache = interaction.client.trailerCache ?? new Map();
	interaction.client.trailerCache.set(malId, trailers);

	await interaction.editReply({
		content: `**${anime?.title ?? 'Anime'}** tiene varios trailers, elige uno:`,
		components: [new ActionRowBuilder().addComponents(select)],
	});
}

async function handleTrailerSelect(interaction, malId) {
	const trailers = interaction.client.trailerCache?.get(malId);
	const index = Number(interaction.values[0]);
	const trailer = trailers?.[index];

	if (!trailer) {
		await interaction.update({ content: 'Este selector ya expiró, usa el botón de Trailer de nuevo.', components: [] });
		return;
	}

	await interaction.update({ content: `${trailer.title}: ${trailer.url}`, components: [] });
}

async function handleInteraction(interaction) {
	if (interaction.isChatInputCommand()) return;

	console.log(`[interactions] customId="${interaction.customId}" de ${interaction.user.tag}`);

	if (interaction.isButton()) {
		const [kind, ...rest] = interaction.customId.split(':');
		if (kind === 'vote') {
			const [voteType, seasonSlug, malId] = rest;
			await handleVoteButton(interaction, voteType, seasonSlug, malId);
		} else if (kind === 'trailer') {
			const [malId] = rest;
			await handleTrailerButton(interaction, malId);
		} else if (kind === 'nav') {
			const [direction, seasonSlug, malId] = rest;
			await handleNavButton(interaction, direction, seasonSlug, malId);
		} else if (kind === 'undovote') {
			const [seasonSlug, malId] = rest;
			await handleUndoVoteButton(interaction, seasonSlug, malId);
		} else if (kind === 'seasonconfirm') {
			const [year, season] = rest;
			await handleSeasonConfirm(interaction, year, season);
		} else if (kind === 'finish') {
			const [seasonSlug] = rest;
			await handleFinishButton(interaction, seasonSlug);
		}
		return;
	}

	if (interaction.isStringSelectMenu()) {
		if (interaction.customId.startsWith('trailerselect:')) {
			const malId = interaction.customId.split(':')[1];
			await handleTrailerSelect(interaction, malId);
		} else if (interaction.customId === 'seasonselect') {
			const [year, season] = interaction.values[0].split(':');
			await handleSeasonSelect(interaction, year, season);
		}
	}
}

module.exports = { handleInteraction };
