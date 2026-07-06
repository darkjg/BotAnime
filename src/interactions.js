const { ActionRowBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { getTrailers, hasPrequel } = require('./services/jikan');
const { setVote, clearVote } = require('./services/sheets');
const { recordVote, removeVote, upsertAnime, getVoteRole, getVoteState, addEpisodesWatched, getProgressForAnime } = require('./services/db');
const { getAnime, rememberAnime, getSeasonLabel } = require('./seasonCache');
const { handleSeasonSelect, handleSeasonConfirm } = require('./commands/temporadaShared');
const { buildAnimeEmbed, buildVoteRow } = require('./components');

async function handleVoteButton(interaction, voteType, seasonSlug, malId) {
	const voteRoleId = getVoteRole(interaction.guildId);
	if (voteRoleId && !interaction.member.roles.cache.has(voteRoleId)) {
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
		// Guarda isSequel/imageUrl ya resueltos: rebuildSeasonTab los necesita para poder recrear esta
		// columna desde la base sin tener que volver a consultarle nada a Jikan ni a Discord.
		upsertAnime({
			malId: anime.malId,
			seasonLabel,
			guildId: interaction.guildId,
			title: animeForSheet.title,
			url: animeForSheet.url,
			imageUrl: animeForSheet.imageUrl,
			broadcastDay: animeForSheet.broadcastDay,
			isSequel: animeForSheet.isSequel,
		});
	}

	console.log(`[interactions] voto "${voteType}" de ${username} para "${anime.title}" (${seasonLabel})`);

	const confirmation = voteType === 'rojo' ? `Anotado: no verás **${anime.title}**.` : `Tu voto para **${anime.title}** se guardó.`;
	await interaction.editReply(confirmation);

	setTimeout(() => {
		interaction.deleteReply().catch(() => {});
	}, 1_000);
}

async function handleUndoVoteButton(interaction, seasonSlug, malId) {
	const voteRoleId = getVoteRole(interaction.guildId);
	if (voteRoleId && !interaction.member.roles.cache.has(voteRoleId)) {
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

// A diferencia del voto, esto no depende de haber votado (ni de qué se votó): cualquiera con el rol
// de votación puede actualizar el progreso, aunque el voto sea rojo o no exista todavía. Es habitual
// que una sola persona actualice el capítulo de todo el grupo a la vez (después de ver un episodio
// juntos), así que en vez de que el botón actúe solo sobre quien lo aprieta, abre un selector de
// usuarios y después un modal para la cantidad (puede ser negativa, para corregir un error).
async function handleEpisodePickButton(interaction, seasonSlug, malId) {
	const voteRoleId = getVoteRole(interaction.guildId);
	if (voteRoleId && !interaction.member.roles.cache.has(voteRoleId)) {
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

	// El selector de usuarios y el modal de cantidad son interacciones separadas de ésta; hace falta
	// guardar a qué anime/temporada/mensaje corresponden para poder retomarlo en cada paso siguiente.
	const token = interaction.id;
	interaction.client.episodeFlowCache = interaction.client.episodeFlowCache ?? new Map();
	interaction.client.episodeFlowCache.set(token, {
		seasonLabel,
		malId: anime.malId,
		animeTitle: anime.title,
		channelId: interaction.channelId,
		messageId: interaction.message.id,
	});

	const select = new UserSelectMenuBuilder()
		.setCustomId(`episodeusers:${token}`)
		.setPlaceholder('Elige a quién actualizar')
		.setMinValues(1)
		.setMaxValues(25);

	await interaction.reply({
		content: `¿A quién le actualizamos el capítulo de **${anime.title}**?`,
		components: [new ActionRowBuilder().addComponents(select)],
		ephemeral: true,
	});
}

async function handleEpisodeUsersSelect(interaction, token) {
	const cached = interaction.client.episodeFlowCache?.get(token);
	if (!cached) {
		await interaction.update({ content: 'Esto ya expiró, usa el botón de "Actualizar capítulo" de nuevo.', components: [] });
		return;
	}

	cached.users = interaction.values.map((id) => ({
		id,
		displayName: interaction.members?.get(id)?.displayName ?? interaction.users.get(id)?.username ?? id,
	}));

	const modal = new ModalBuilder().setCustomId(`episodeamount:${token}`).setTitle('Actualizar capítulo');
	const amountInput = new TextInputBuilder()
		.setCustomId('amount')
		.setLabel('¿Cuántos capítulos? (negativo para restar)')
		.setStyle(TextInputStyle.Short)
		.setValue('1')
		.setRequired(true);
	modal.addComponents(new ActionRowBuilder().addComponents(amountInput));

	await interaction.showModal(modal);
}

async function handleEpisodeAmountModal(interaction, token) {
	const cached = interaction.client.episodeFlowCache?.get(token);
	interaction.client.episodeFlowCache?.delete(token);
	if (!cached?.users) {
		await interaction.reply({ content: 'Esto ya expiró, usa el botón de "Actualizar capítulo" de nuevo.', ephemeral: true });
		return;
	}

	const raw = interaction.fields.getTextInputValue('amount').trim();
	const delta = Number(raw);
	if (!Number.isInteger(delta) || delta === 0) {
		await interaction.reply({ content: `"${raw}" no es un número entero válido (probá con 1, -1, 3, etc).`, ephemeral: true });
		return;
	}

	const { seasonLabel, malId, animeTitle, channelId, messageId, users } = cached;
	for (const { id, displayName } of users) {
		addEpisodesWatched({ seasonLabel, malId, discordId: id, displayName, delta });
	}

	console.log(
		`[interactions] ${interaction.member.displayName} sumó ${delta > 0 ? '+' : ''}${delta} capítulo(s) a ${users.length} persona(s) para "${animeTitle}" (${seasonLabel})`,
	);

	const anime = getAnime(malId);
	const voteState = getVoteState({ seasonLabel, malId });
	const progress = getProgressForAnime({ seasonLabel, malId });

	try {
		const channel = await interaction.client.channels.fetch(channelId);
		const message = await channel.messages.fetch(messageId);
		await message.edit({
			embeds: [buildAnimeEmbed(anime, { voteState, progress })],
			components: buildVoteRow(seasonLabel, malId, { voteState }),
		});
	} catch (err) {
		console.error('[interactions] no pude actualizar el mensaje del hilo tras actualizar el capítulo:', err.message);
	}

	const names = users.map((u) => `**${u.displayName}**`).join(', ');
	await interaction.reply({
		content: `Listo: ${delta > 0 ? '+' : ''}${delta} capítulo(s) para ${names} en **${animeTitle}**.`,
		ephemeral: true,
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
		} else if (kind === 'undovote') {
			const [seasonSlug, malId] = rest;
			await handleUndoVoteButton(interaction, seasonSlug, malId);
		} else if (kind === 'episodepick') {
			const [seasonSlug, malId] = rest;
			await handleEpisodePickButton(interaction, seasonSlug, malId);
		} else if (kind === 'seasonconfirm') {
			const [year, season] = rest;
			await handleSeasonConfirm(interaction, year, season);
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
		return;
	}

	if (interaction.isUserSelectMenu()) {
		if (interaction.customId.startsWith('episodeusers:')) {
			const token = interaction.customId.split(':')[1];
			await handleEpisodeUsersSelect(interaction, token);
		}
		return;
	}

	if (interaction.isModalSubmit()) {
		if (interaction.customId.startsWith('episodeamount:')) {
			const token = interaction.customId.split(':')[1];
			await handleEpisodeAmountModal(interaction, token);
		}
	}
}

module.exports = { handleInteraction };
