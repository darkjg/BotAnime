const { ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { getTrailers, hasPrequel } = require('./services/jikan');
const { relocateAnimeColumn } = require('./services/sheets');
const {
	recordVote,
	removeVote,
	upsertAnime,
	setAnimeAbandoned,
	getVoteRole,
	getVoteState,
	getUserVote,
	getWatchers,
	addEpisodesWatched,
	getEpisodesWatched,
	getWatchersWithProgress,
	getAnimeAcrossGuilds,
	getDisplayTitle,
} = require('./services/db');
const { getAnime, rememberAnime, getSeasonLabel } = require('./seasonCache');
const { handleSeasonSelect, handleSeasonConfirm } = require('./commands/temporadaShared');
const { handleSelect: handleEnComunSelect, handlePageButton: handleEnComunPageButton } = require('./commands/enComun');
const { handleSelect: handlePendientesSelect, handleSoloButton: handlePendientesSoloButton, handlePageButton: handlePendientesPageButton } = require('./commands/pendientes');
const { handleCancelButton: handleReminderCancelButton } = require('./commands/recordatorio');
const { handleQuedadaPersonasSelect, handleQuedadaCrearModal } = require('./commands/quedada');
const { buildAnimeEmbed, buildVoteRow } = require('./components');
const { autoCleanupReply } = require('./ephemeral');
const { reabrirSiArchivado } = require('./threadUtil');
const { refrescarCeldaDeProgreso, limpiarCeldaDeVoto, motivoFalloSheet, textoFallosSheet } = require('./sheetProgress');
const { esErrorDeCuota } = require('./services/reintento');
const { handleAv1WarpButton } = require('./av1Backup');

// Si tras un voto (o deshacerlo) ya no queda nadie viendo un anime, se marca automáticamente como
// "abandonado" y se reubica su columna a esa sección de la sheet; si alguien vuelve a votar verde/
// naranja por algo que estaba marcado así, se desmarca y vuelve a su sección normal (nuevo/secuela/
// CONTINUAN, según corresponda). malId identifica al anime más allá del guild (ver
// getAnimeAcrossGuilds), así que basta con reubicarlo una vez: todos los registros de guild comparten
// la misma columna física en la sheet.
async function syncAbandonedState(seasonLabel, malId, animeTitle) {
	const registros = getAnimeAcrossGuilds({ seasonLabel, malId });
	const wasAbandoned = registros.some((r) => r.isAbandoned);
	const shouldBeAbandoned = getWatchers({ seasonLabel, malId }).length === 0;
	if (shouldBeAbandoned === wasAbandoned) return;

	setAnimeAbandoned({ seasonLabel, malId, abandoned: shouldBeAbandoned });
	const [registro] = getAnimeAcrossGuilds({ seasonLabel, malId });
	if (!registro) return;
	try {
		await relocateAnimeColumn(seasonLabel, { ...registro, title: getDisplayTitle(registro) });
		console.log(`[interactions] "${animeTitle}" ${shouldBeAbandoned ? 'marcado como abandonado' : 'ya no está abandonado'}, columna reubicada`);
	} catch (err) {
		console.error(`[interactions] no pude reubicar "${animeTitle}" (abandonado=${shouldBeAbandoned}):`, err.message);
	}
}

async function handleVoteButton(interaction, voteType, seasonSlug, malId) {
	const voteRoleId = getVoteRole(interaction.guildId);
	if (voteRoleId && !interaction.member.roles.cache.has(voteRoleId)) {
		await interaction.reply({ content: 'No tienes el rol necesario para votar.', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}

	const anime = getAnime(Number(malId));
	if (!anime) {
		await interaction.reply({
			content: 'No encuentro este anime en memoria (¿se reinició el bot?). Vuelve a correr /temporada.',
			ephemeral: true,
		});
		autoCleanupReply(interaction);
		return;
	}

	const seasonLabel = getSeasonLabel(seasonSlug);
	if (!seasonLabel) {
		await interaction.reply({
			content: 'No encuentro la temporada en memoria (¿se reinició el bot?). Vuelve a correr /temporada.',
			ephemeral: true,
		});
		autoCleanupReply(interaction);
		return;
	}

	await interaction.deferReply({ ephemeral: true });

	const username = interaction.member.displayName;
	const animeForSheet =
		voteType === 'rojo' ? anime : { ...anime, isSequel: anime.isSequel || (await hasPrequel(anime.malId)) };
	if (voteType !== 'rojo') rememberAnime(animeForSheet);
	const episodesWatched = getEpisodesWatched({ seasonLabel, malId: anime.malId, discordId: interaction.member.id });
	// La sheet es una sola: el voto se escribe una vez (ver sheetProgress.js). Si falla (cuota de Google tras los
	// reintentos u otro error) no se guarda nada y se avisa, así la base y la sheet no quedan distintas.
	const escrito = await refrescarCeldaDeProgreso({
		seasonLabel,
		malId: anime.malId,
		displayName: username,
		voteType,
		episodesWatched,
		extra: { isSequel: animeForSheet.isSequel },
	});
	if (!escrito.ok) {
		console.error(`[interactions] no pude escribir el voto de "${username}" para "${anime.title}" en la sheet:`, escrito.error.message);
		await interaction.editReply(`No pude guardar tu voto: ${motivoFalloSheet(escrito.error)}. Probá de nuevo en un minuto.`);
		autoCleanupReply(interaction);
		return;
	}

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

	await syncAbandonedState(seasonLabel, anime.malId, anime.title);

	// Refresca el embed del propio hilo (color según voteState + quién lo ve y por qué capítulo va) para
	// que el voto se vea reflejado ahí mismo, no solo en la sheet.
	const voteState = getVoteState({ seasonLabel, malId: anime.malId });
	const progress = getWatchersWithProgress({ seasonLabel, malId: anime.malId });
	try {
		await reabrirSiArchivado(interaction.channel);
		await interaction.message.edit({
			embeds: [buildAnimeEmbed(animeForSheet, { voteState, progress })],
			components: buildVoteRow(seasonLabel, anime.malId, { voteState }),
		});
	} catch (err) {
		console.error(`[interactions] no pude actualizar el embed de "${anime.title}" tras el voto:`, err.message);
	}

	console.log(`[interactions] voto "${voteType}" de ${username} para "${anime.title}" (${seasonLabel})`);

	const displayTitle = getDisplayTitle(anime);
	const confirmation = voteType === 'rojo' ? `Anotado: no verás **${displayTitle}**.` : `Tu voto para **${displayTitle}** se guardó.`;
	await interaction.editReply(confirmation);

	setTimeout(() => {
		interaction.deleteReply().catch(() => {});
	}, 1_000);
}

async function handleUndoVoteButton(interaction, seasonSlug, malId) {
	const voteRoleId = getVoteRole(interaction.guildId);
	if (voteRoleId && !interaction.member.roles.cache.has(voteRoleId)) {
		await interaction.reply({ content: 'No tienes el rol necesario para votar.', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}

	const anime = getAnime(Number(malId));
	const seasonLabel = getSeasonLabel(seasonSlug);
	if (!anime || !seasonLabel) {
		await interaction.reply({
			content: 'No encuentro esto en memoria (¿se reinició el bot?). Vuelve a correr /temporada.',
			ephemeral: true,
		});
		autoCleanupReply(interaction);
		return;
	}

	await interaction.deferReply({ ephemeral: true });

	const username = interaction.member.displayName;
	// Igual que al votar: la sheet es una sola, se limpia una vez. Si falla, el voto no se borra de la base.
	const limpio = await limpiarCeldaDeVoto({ seasonLabel, malId: anime.malId, displayName: username });
	if (!limpio.ok) {
		console.error(`[interactions] no pude limpiar el voto de "${username}" para "${anime.title}" en la sheet:`, limpio.error.message);
		await interaction.editReply(`No pude borrar tu voto: ${motivoFalloSheet(limpio.error)}. Probá de nuevo en un minuto.`);
		autoCleanupReply(interaction);
		return;
	}
	const cleared = limpio.cleared;
	removeVote({ seasonLabel, malId: anime.malId, discordId: interaction.member.id });

	await syncAbandonedState(seasonLabel, anime.malId, anime.title);

	const voteState = getVoteState({ seasonLabel, malId: anime.malId });
	const progress = getWatchersWithProgress({ seasonLabel, malId: anime.malId });
	try {
		await reabrirSiArchivado(interaction.channel);
		await interaction.message.edit({
			embeds: [buildAnimeEmbed(anime, { voteState, progress })],
			components: buildVoteRow(seasonLabel, anime.malId, { voteState }),
		});
	} catch (err) {
		console.error(`[interactions] no pude actualizar el embed de "${anime.title}" tras deshacer el voto:`, err.message);
	}

	console.log(`[interactions] deshacer voto de ${username} para "${anime.title}" (${seasonLabel}): ${cleared ? 'borrado' : 'no había voto'}`);

	const displayTitle = getDisplayTitle(anime);
	const confirmation = cleared ? `Borré tu voto para **${displayTitle}**.` : `No tenías un voto guardado para **${displayTitle}**.`;
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
		autoCleanupReply(interaction);
		return;
	}

	const anime = getAnime(Number(malId));
	const seasonLabel = getSeasonLabel(seasonSlug);
	if (!anime || !seasonLabel) {
		await interaction.reply({
			content: 'No encuentro esto en memoria (¿se reinició el bot?). Vuelve a correr /temporada.',
			ephemeral: true,
		});
		autoCleanupReply(interaction);
		return;
	}

	// El selector nativo de usuarios de Discord (UserSelectMenu) busca sobre la lista de miembros que
	// el cliente de Discord tiene cargada, y en servidores grandes no siempre encuentra a todos por
	// nombre. Por eso se arma un StringSelectMenu a mano listando directamente (desde la caché del bot)
	// a quienes tienen voto verde/naranja en ESTE anime (getWatchers ya excluye voto rojo y a quien no
	// votó): no tiene sentido ofrecer actualizar el capítulo de alguien que no lo va a ver.
	if (interaction.guild.members.cache.size < interaction.guild.memberCount) {
		try {
			await interaction.guild.members.fetch();
		} catch (err) {
			console.error('[interactions] no pude refrescar la lista de miembros para el selector de capítulo:', err.message);
		}
	}
	const watcherIds = new Set(getWatchers({ seasonLabel, malId: anime.malId }));
	const eligible = interaction.guild.members.cache
		.filter((member) => watcherIds.has(member.id))
		.map((member) => ({ id: member.id, displayName: member.displayName }))
		.sort((a, b) => a.displayName.localeCompare(b.displayName));

	if (eligible.length === 0) {
		await interaction.reply({ content: 'Nadie está votando este anime todavía, no hay a quién actualizarle el capítulo.', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}

	// El selector de usuarios y el modal de cantidad son interacciones separadas de ésta; hace falta
	// guardar a qué anime/temporada/mensaje corresponden para poder retomarlo en cada paso siguiente.
	const token = interaction.id;
	interaction.client.episodeFlowCache = interaction.client.episodeFlowCache ?? new Map();
	interaction.client.episodeFlowCache.set(token, {
		seasonLabel,
		malId: anime.malId,
		animeTitle: getDisplayTitle(anime),
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
		content: `¿A quién le actualizamos el capítulo de **${getDisplayTitle(anime)}**?${truncated ? ' (mostrando los primeros 25 con el rol)' : ''}`,
		components: [new ActionRowBuilder().addComponents(select)],
		ephemeral: true,
	});
}

async function handleEpisodeUsersSelect(interaction, token) {
	const cached = interaction.client.episodeFlowCache?.get(token);
	if (!cached) {
		await interaction.update({ content: 'Esto ya expiró, usa el botón de "Actualizar capítulo" de nuevo.', components: [] });
		autoCleanupReply(interaction);
		return;
	}

	// El selector ya solo ofrecía a quienes votaban este anime; este re-chequeo es solo por si alguien
	// quitó su voto (o votó rojo) justo entre que se abrió el selector y se envió la elección.
	const watcherIds = new Set(getWatchers({ seasonLabel: cached.seasonLabel, malId: cached.malId }));
	const selected = interaction.values.map((id) => {
		const member = interaction.guild.members.cache.get(id);
		return { id, displayName: member?.displayName ?? id, isWatching: watcherIds.has(id) };
	});

	const withoutRole = selected.filter((u) => !u.isWatching);
	const users = selected.filter((u) => u.isWatching);

	if (users.length === 0) {
		await interaction.update({
			content: `Ninguno de los elegidos sigue votando este anime, no se actualizó nada: ${withoutRole.map((u) => `**${u.displayName}**`).join(', ')}.`,
			components: [],
		});
		autoCleanupReply(interaction);
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
		autoCleanupReply(interaction);
		return;
	}

	const raw = interaction.fields.getTextInputValue('amount').trim();
	const delta = Number(raw);
	if (!Number.isInteger(delta) || delta === 0) {
		await interaction.editReply(`"${raw}" no es un número entero válido (probá con 1, -1, 3, etc).`);
		autoCleanupReply(interaction);
		return;
	}

	const { seasonLabel, malId, animeTitle, channelId, messageId, users, withoutRole } = cached;
	const anime = getAnime(malId);
	// La sheet es una sola: por persona se escribe una vez (ver sheetProgress.js). Si Google sigue limitando las
	// consultas tras los reintentos se deja de intentar con el resto (cada intento puede esperar hasta 2
	// minutos) y se avisa: el capítulo de todos queda guardado en la base igual.
	const fallidos = [];
	const resultados = [];
	let errorCuota = null;
	for (const { id, displayName } of users) {
		const episodesWatched = addEpisodesWatched({ seasonLabel, malId, discordId: id, displayName, delta });
		resultados.push({ displayName, episodesWatched });

		// Si ya tiene un voto puesto, la celda de la sheet queda vieja hasta que se refresque con el
		// capítulo nuevo; si no votó (o votó rojo), no hay celda que actualizar.
		const vote = getUserVote({ seasonLabel, malId, discordId: id });
		if (!vote || vote.voteType === 'rojo') continue;
		if (errorCuota) {
			fallidos.push({ displayName, error: errorCuota });
			continue;
		}

		const resultado = await refrescarCeldaDeProgreso({ seasonLabel, malId, displayName, voteType: vote.voteType, episodesWatched });
		if (!resultado.ok) {
			console.error(`[interactions] no pude refrescar la celda de "${displayName}" en la sheet:`, resultado.error.message);
			fallidos.push({ displayName, error: resultado.error });
			if (esErrorDeCuota(resultado.error)) errorCuota = resultado.error;
		}
	}

	console.log(
		`[interactions] ${interaction.member.displayName} sumó ${delta > 0 ? '+' : ''}${delta} capítulo(s) a ${users.length} persona(s) para "${animeTitle}" (${seasonLabel})`,
	);

	const voteState = getVoteState({ seasonLabel, malId });
	const progress = getWatchersWithProgress({ seasonLabel, malId });

	try {
		const channel = await interaction.client.channels.fetch(channelId);
		await reabrirSiArchivado(channel);
		const message = await channel.messages.fetch(messageId);
		await message.edit({
			embeds: [buildAnimeEmbed(anime, { voteState, progress })],
			components: buildVoteRow(seasonLabel, malId, { voteState }),
		});
	} catch (err) {
		console.error('[interactions] no pude actualizar el mensaje del hilo tras actualizar el capítulo:', err.message);
	}

	// Cada quien puede venir de un capítulo distinto, así que el mismo "+1" les deja un número final
	// diferente: se muestra el capítulo al que quedó cada uno, no solo cuánto se sumó.
	const names = resultados.map((r) => `**${r.displayName}** (cap. ${r.episodesWatched})`).join(', ');
	const skippedNote =
		withoutRole?.length > 0 ? ` (sin actualizar por ya no votar este anime: ${withoutRole.map((u) => `**${u.displayName}**`).join(', ')})` : '';
	await interaction.editReply(`Listo: ${delta > 0 ? '+' : ''}${delta} capítulo(s) para ${names} en **${animeTitle}**.${skippedNote}${textoFallosSheet(fallidos)}`);
	autoCleanupReply(interaction);
}

async function handleTrailerButton(interaction, malId) {
	await interaction.deferReply({ ephemeral: true });
	const anime = getAnime(Number(malId));
	const trailers = await getTrailers(Number(malId));

	const animeDisplayTitle = anime ? getDisplayTitle(anime) : null;

	if (trailers.length === 0) {
		await interaction.editReply(`No hay trailer disponible para **${animeDisplayTitle ?? 'este anime'}**.`);
		autoCleanupReply(interaction);
		return;
	}

	if (trailers.length === 1) {
		await interaction.editReply(`${trailers[0].title}: ${trailers[0].url}`);
		autoCleanupReply(interaction);
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
		content: `**${animeDisplayTitle ?? 'Anime'}** tiene varios trailers, elige uno:`,
		components: [new ActionRowBuilder().addComponents(select)],
	});
}

async function handleTrailerSelect(interaction, malId) {
	const trailers = interaction.client.trailerCache?.get(malId);
	const index = Number(interaction.values[0]);
	const trailer = trailers?.[index];

	if (!trailer) {
		await interaction.update({ content: 'Este selector ya expiró, usa el botón de Trailer de nuevo.', components: [] });
		autoCleanupReply(interaction);
		return;
	}

	await interaction.update({ content: `${trailer.title}: ${trailer.url}`, components: [] });
	autoCleanupReply(interaction);
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
		} else if (kind === 'pendientessolo') {
			await handlePendientesSoloButton(interaction);
		} else if (kind === 'encomunpage') {
			const [token, pageIndex] = rest;
			await handleEnComunPageButton(interaction, token, pageIndex);
		} else if (kind === 'pendientespage') {
			const [token, pageIndex] = rest;
			await handlePendientesPageButton(interaction, token, pageIndex);
		} else if (kind === 'av1warp') {
			await handleAv1WarpButton(interaction, rest[0]);
		} else if (kind === 'remindercancel') {
			await handleReminderCancelButton(interaction, rest[0]);
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
		} else if (interaction.customId === 'encomun') {
			await handleEnComunSelect(interaction);
		} else if (interaction.customId === 'pendientes') {
			await handlePendientesSelect(interaction);
		} else if (interaction.customId.startsWith('quedadapersonas:')) {
			const token = interaction.customId.split(':')[1];
			await handleQuedadaPersonasSelect(interaction, token);
		}
		return;
	}

	if (interaction.isModalSubmit()) {
		if (interaction.customId.startsWith('episodeamount:')) {
			const token = interaction.customId.split(':')[1];
			await handleEpisodeAmountModal(interaction, token);
		} else if (interaction.customId.startsWith('quedadacrear:')) {
			const token = interaction.customId.split(':')[1];
			await handleQuedadaCrearModal(interaction, token);
		}
	}
}

module.exports = { handleInteraction, syncAbandonedState };
