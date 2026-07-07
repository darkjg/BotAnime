const { ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { getTrailers, hasPrequel } = require('./services/jikan');
const { setVote, clearVote } = require('./services/sheets');
const {
	recordVote,
	removeVote,
	upsertAnime,
	getVoteRole,
	getVoteState,
	getUserVote,
	addEpisodesWatched,
	getEpisodesWatched,
	getProgressForAnime,
} = require('./services/db');
const { getAnime, rememberAnime, getSeasonLabel } = require('./seasonCache');
const { handleSeasonSelect, handleSeasonConfirm } = require('./commands/temporadaShared');
const { buildAnimeEmbed, buildVoteRow } = require('./components');

// Discord no permite filtrar por rol un UserSelectMenu (solo existe para Role Select), así que el
// filtro se aplica después de elegir: a "Actualizar capítulo" solo pueden entrar quienes tengan este rol.
const EPISODE_UPDATE_ROLE_ID = '1508943288311480370';

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
	const episodesWatched = getEpisodesWatched({ seasonLabel, malId: anime.malId, discordId: interaction.member.id });
	await setVote(seasonLabel, username, animeForSheet, voteType, episodesWatched);

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

	// El selector nativo de usuarios de Discord (UserSelectMenu) busca sobre la lista de miembros que
	// el cliente de Discord tiene cargada, y en servidores grandes no siempre encuentra a todos por
	// nombre; además no se puede restringir por rol. Por eso se arma un StringSelectMenu a mano listando
	// directamente (desde la caché del bot) a quienes tienen el rol, así siempre aparecen y quedan
	// automáticamente filtrados.
	if (interaction.guild.members.cache.size < interaction.guild.memberCount) {
		try {
			await interaction.guild.members.fetch();
		} catch (err) {
			console.error('[interactions] no pude refrescar la lista de miembros para el selector de capítulo:', err.message);
		}
	}
	const eligible = interaction.guild.members.cache
		.filter((member) => member.roles.cache.has(EPISODE_UPDATE_ROLE_ID))
		.map((member) => ({ id: member.id, displayName: member.displayName }))
		.sort((a, b) => a.displayName.localeCompare(b.displayName));

	if (eligible.length === 0) {
		await interaction.reply({ content: 'Nadie en el servidor tiene el rol necesario para actualizar capítulos.', ephemeral: true });
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

	// Discord no deja más de 25 opciones por selector; con más gente con el rol que eso, se recorta y
	// se avisa en vez de romper el comando.
	const truncated = eligible.length > 25;
	const select = new StringSelectMenuBuilder()
		.setCustomId(`episodeusers:${token}`)
		.setPlaceholder('Elige a quién actualizar')
		.setMinValues(1)
		.setMaxValues(Math.min(eligible.length, 25))
		.addOptions(eligible.slice(0, 25).map((u) => ({ label: u.displayName, value: u.id })));

	await interaction.reply({
		content: `¿A quién le actualizamos el capítulo de **${anime.title}**?${truncated ? ' (mostrando los primeros 25 con el rol)' : ''}`,
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

	// El selector ya solo ofrecía gente con el rol; este re-chequeo es solo por si a alguien se lo
	// sacaron justo entre que se abrió el selector y se envió la elección.
	const selected = interaction.values.map((id) => {
		const member = interaction.guild.members.cache.get(id);
		return { id, displayName: member?.displayName ?? id, hasRole: member?.roles.cache.has(EPISODE_UPDATE_ROLE_ID) ?? false };
	});

	const withoutRole = selected.filter((u) => !u.hasRole);
	const users = selected.filter((u) => u.hasRole);

	if (users.length === 0) {
		await interaction.update({
			content: `Ninguno de los elegidos tiene el rol necesario, no se actualizó nada: ${withoutRole.map((u) => `**${u.displayName}**`).join(', ')}.`,
			components: [],
		});
		return;
	}

	cached.users = users;
	cached.withoutRole = withoutRole;

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
	// Lo que sigue escribe en Sheets y edita el mensaje del hilo, que puede tardar más de los 3
	// segundos que da Discord para responder sin deferir; sin este defer, cualquier lentitud (cuota de
	// Sheets, rate limit) hace que el reply final falle con "Unknown interaction" aunque el capítulo sí
	// se haya actualizado.
	await interaction.deferReply({ ephemeral: true });

	const cached = interaction.client.episodeFlowCache?.get(token);
	interaction.client.episodeFlowCache?.delete(token);
	if (!cached?.users) {
		await interaction.editReply('Esto ya expiró, usa el botón de "Actualizar capítulo" de nuevo.');
		return;
	}

	const raw = interaction.fields.getTextInputValue('amount').trim();
	const delta = Number(raw);
	if (!Number.isInteger(delta) || delta === 0) {
		await interaction.editReply(`"${raw}" no es un número entero válido (probá con 1, -1, 3, etc).`);
		return;
	}

	const { seasonLabel, malId, animeTitle, channelId, messageId, users, withoutRole } = cached;
	const anime = getAnime(malId);
	for (const { id, displayName } of users) {
		const episodesWatched = addEpisodesWatched({ seasonLabel, malId, discordId: id, displayName, delta });

		// Si ya tiene un voto puesto, la celda de la sheet queda vieja hasta que se refresque con el
		// capítulo nuevo; si no votó (o votó rojo), no hay celda que actualizar.
		const vote = getUserVote({ seasonLabel, malId, discordId: id });
		if (vote && vote.voteType !== 'rojo') {
			try {
				await setVote(seasonLabel, displayName, anime, vote.voteType, episodesWatched);
			} catch (err) {
				console.error(`[interactions] no pude refrescar la celda de "${displayName}" en la sheet:`, err.message);
			}
		}
	}

	console.log(
		`[interactions] ${interaction.member.displayName} sumó ${delta > 0 ? '+' : ''}${delta} capítulo(s) a ${users.length} persona(s) para "${animeTitle}" (${seasonLabel})`,
	);

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
	const skippedNote =
		withoutRole?.length > 0 ? ` (sin actualizar por no tener el rol: ${withoutRole.map((u) => `**${u.displayName}**`).join(', ')})` : '';
	await interaction.editReply(`Listo: ${delta > 0 ? '+' : ''}${delta} capítulo(s) para ${names} en **${animeTitle}**.${skippedNote}`);
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
		} else if (interaction.customId.startsWith('episodeusers:')) {
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
