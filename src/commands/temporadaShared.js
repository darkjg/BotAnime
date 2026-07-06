const {
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	ForumLayoutType,
	MessageFlags,
} = require('discord.js');
const { getSeasonAnime, getAnimeById } = require('../services/jikan');
const { ensureSeasonTab, ensureAnimeColumn, getPreviousTabMalIds, getPreviousSeasonLabel, setVote } = require('../services/sheets');
const {
	upsertAnime,
	getVoteState,
	getForumChannel,
	setForumChannel,
	setActiveSeason,
	getVoteRole,
	getVotesForSeason,
	recordVote,
	getEpisodesWatched,
	setEpisodesWatched,
} = require('../services/db');
const { defaultSeasonLabel, slugForCustomId, JIKAN_SEASON_TO_ES, seasonAtOffset } = require('../seasonLabel');
const { rememberAnime, rememberSeasonLabel } = require('../seasonCache');
const { buildAnimeEmbed, buildVoteRow } = require('../components');

const SEASON_PICKER_RANGE = { from: -2, to: 4 }; // temporadas relativas a la actual que se muestran en el selector
const FORUM_TAG_NAMES = ['Nuevo', 'Secuela', 'CONTINUAN'];
// Con concurrencia 4 y sin pausa, crear ~36 hilos disparó un rate limit "grande" de Discord que
// discord.js esperó en silencio durante más de 3 minutos (sin tirar error, simplemente se frenó
// todo). Bajamos la concurrencia y agregamos un margen entre tandas para no volver a pegarle a eso.
const FORUM_THREAD_CONCURRENCY = 2;
const FORUM_BATCH_DELAY_MS = 350;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(array, size) {
	const chunks = [];
	for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
	return chunks;
}

// La temporada siempre se elige con el selector; el único parámetro manual es el nombre de la
// pestaña de la sheet, por si hay que pisar el que se calcula automáticamente.
function buildTemporadaCommandData(name, description) {
	return new SlashCommandBuilder()
		.setName(name)
		.setDescription(description)
		.addStringOption((option) =>
			option
				.setName('nombre')
				.setDescription('Nombre de la pestaña de la sheet, ej: "Verano 2026". Si se omite, se calcula automáticamente.')
				.setRequired(false),
		);
}

async function getVoterNames(interaction) {
	const byId = new Map();
	const voteRoleId = interaction.guild ? getVoteRole(interaction.guildId) : null;

	if (voteRoleId && interaction.guild) {
		// Pedirle a Discord la lista completa de miembros tiene su propio rate limit a nivel gateway
		// (independiente del de la API REST), que se dispara fácil si el comando se corre varias veces
		// seguidas. Si ya tenemos a todos en caché no hace falta volver a pedirlo, y si la pedida falla
		// igual seguimos con lo que haya en caché en vez de romper el comando entero.
		if (interaction.guild.members.cache.size < interaction.guild.memberCount) {
			try {
				await interaction.guild.members.fetch();
			} catch (err) {
				console.error('[temporada] no pude refrescar la lista de miembros, sigo con lo que haya en caché:', err.message);
			}
		}
		const role = interaction.guild.roles.cache.get(voteRoleId);
		role?.members.forEach((member) => byId.set(member.id, member.displayName));
	}

	return [...byId.values()];
}

function seasonOptionLabel({ year, season }) {
	return `${JIKAN_SEASON_TO_ES[season]} ${year}`;
}

function buildSeasonSelectRow() {
	const options = [];
	for (let offset = SEASON_PICKER_RANGE.from; offset <= SEASON_PICKER_RANGE.to; offset += 1) {
		const { year, season } = seasonAtOffset(offset);
		options.push({ label: seasonOptionLabel({ year, season }), value: `${year}:${season}` });
	}

	const select = new StringSelectMenuBuilder().setCustomId('seasonselect').setPlaceholder('Elige la temporada a publicar').addOptions(options);
	return new ActionRowBuilder().addComponents(select);
}

function buildConfirmRow(year, season) {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId(`seasonconfirm:${year}:${season}`).setLabel('Confirmar').setStyle(ButtonStyle.Success),
	);
}

// Punto de entrada de /temporada-foro: siempre muestra el selector de temporada y al confirmar
// publica los hilos de foro.
async function runTemporadaCommand(interaction) {
	await interaction.deferReply();

	const nombreOverride = interaction.options.getString('nombre');
	const voterNames = await getVoterNames(interaction);

	await interaction.editReply({ content: '¿Qué temporada quieres publicar?', components: [buildSeasonSelectRow()] });
	const message = await interaction.fetchReply();
	interaction.client.seasonPickerCache = interaction.client.seasonPickerCache ?? new Map();
	interaction.client.seasonPickerCache.set(message.id, { nombreOverride, voterNames });
}

// Llamada desde interactions.js tras elegir una opción del selector: muestra un botón de
// confirmación antes de publicar nada, por si el usuario se equivocó de temporada.
async function handleSeasonSelect(interaction, year, season) {
	await interaction.update({
		content: `Vas a publicar **${seasonOptionLabel({ year, season })}**. ¿Confirmas?`,
		components: [buildConfirmRow(year, season)],
	});
}

// Llamada desde interactions.js al pulsar "Confirmar": recupera el nombre/voters guardados al abrir
// el selector (van ligados al mensaje, no a esta nueva interacción) y publica la temporada.
async function handleSeasonConfirm(interaction, year, season) {
	const pending = interaction.client.seasonPickerCache?.get(interaction.message.id) ?? {};
	interaction.client.seasonPickerCache?.delete(interaction.message.id);

	await interaction.update({ content: `Publicando **${seasonOptionLabel({ year, season })}**...`, components: [] });

	await publishSeasonForum({
		interaction,
		respond: (content) => interaction.editReply(content),
		year: Number(year),
		season,
		nombreOverride: pending.nombreOverride,
		voterNames: pending.voterNames ?? [],
	});
}

// Resuelve la lista de animes de la temporada, prepara la pestaña de la sheet y devuelve todo lo
// necesario para publicarla, sin tocar todavía el canal/foro de destino (eso lo hace cada modo).
async function prepareSeason({ guildId, year, season, nombreOverride }) {
	console.log(`[temporada] resolviendo ${season} ${year} (guild ${guildId})...`);
	const anime = await getSeasonAnime(year, season);
	console.log(`[temporada] Jikan devolvió ${anime.length} animes para ${season} ${year}`);
	if (anime.length === 0) return null;

	const seasonLabel = nombreOverride ?? defaultSeasonLabel(anime[0]);
	await ensureSeasonTab(seasonLabel);
	anime.forEach(rememberAnime);
	const seasonSlug = slugForCustomId(seasonLabel);
	rememberSeasonLabel(seasonSlug, seasonLabel);
	setActiveSeason({ guildId, seasonLabel });

	for (const entry of anime) {
		upsertAnime({
			malId: entry.malId,
			seasonLabel,
			guildId,
			title: entry.title,
			url: entry.url,
			imageUrl: entry.imageUrl,
			broadcastDay: entry.broadcastDay,
			isSequel: entry.isSequel,
		});
	}

	const carryoverCount = await addCarryoverAnime(seasonLabel, anime, guildId);
	console.log(`[temporada] "${seasonLabel}" lista: ${anime.length} animes + ${carryoverCount} carryover`);

	return { seasonLabel, anime, carryoverCount };
}

// El campo `status` de Jikan/MAL puede quedar en "Currently Airing" un tiempo después de que el
// último episodio ya salió al aire (no se actualiza al instante); por eso además del status hay que
// chequear que la fecha de fin (aired.to) no haya pasado todavía.
function isActuallyAiring(anime) {
	if (anime.status !== 'Currently Airing') return false;
	if (!anime.airedTo) return true;
	return new Date(anime.airedTo) >= new Date();
}

// Animes que ya estaban en la pestaña anterior (en cualquiera de sus bloques) y que en MAL siguen
// emitiéndose se agregan directo al subgrupo CONTINUAN, sin esperar a que alguien vote.
// El orden por día de emisión dentro de la sheet lo decide ensureAnimeColumn al insertar.
async function addCarryoverAnime(seasonLabel, currentSeasonAnime, guildId) {
	const currentMalIds = new Set(currentSeasonAnime.map((a) => a.malId));
	const previousMalIds = await getPreviousTabMalIds(seasonLabel);
	const previousSeasonLabel = await getPreviousSeasonLabel(seasonLabel);

	console.log(`[temporada] revisando ${previousMalIds.length} animes de la temporada anterior para carryover...`);
	let count = 0;
	for (const malId of previousMalIds) {
		if (currentMalIds.has(malId)) continue;
		try {
			const fullAnime = await getAnimeById(malId);
			if (!isActuallyAiring(fullAnime)) {
				console.log(`[temporada] "${fullAnime.title}" ya terminó (status: ${fullAnime.status}, fin: ${fullAnime.airedTo ?? 'desconocido'}), no va a CONTINUAN`);
				continue;
			}
			rememberAnime(fullAnime);
			const carryoverAnime = { ...fullAnime, isCarryover: true };
			await ensureAnimeColumn(seasonLabel, carryoverAnime);
			upsertAnime({
				malId: fullAnime.malId,
				seasonLabel,
				guildId,
				title: fullAnime.title,
				url: fullAnime.url,
				imageUrl: fullAnime.imageUrl,
				broadcastDay: fullAnime.broadcastDay,
				isCarryover: true,
			});
			console.log(`[temporada] carryover: "${fullAnime.title}" sigue en emisión, agregado a CONTINUAN`);
			count += 1;

			if (previousSeasonLabel) {
				await carryOverVotesAndProgress(previousSeasonLabel, seasonLabel, carryoverAnime);
			}
		} catch (err) {
			console.error(`[temporada] no pude revisar el malId ${malId} para carryover:`, err.message);
		}
	}
	return count;
}

// Traslada a la temporada nueva quién seguía este anime (voto verde/naranja) y en qué capítulo iba
// cada quien en la temporada anterior: es el mismo anime continuando, no tiene sentido que la gente
// tenga que volver a votar ni que el contador de capítulo vuelva a 0.
async function carryOverVotesAndProgress(previousSeasonLabel, seasonLabel, anime) {
	const previousVotes = getVotesForSeason(previousSeasonLabel).filter(
		(v) => v.malId === anime.malId && (v.voteType === 'verde' || v.voteType === 'naranja'),
	);

	for (const vote of previousVotes) {
		try {
			await setVote(seasonLabel, vote.displayName, anime, vote.voteType);
			recordVote({ seasonLabel, malId: anime.malId, discordId: vote.discordId, displayName: vote.displayName, voteType: vote.voteType });

			const previousEpisodes = getEpisodesWatched({ seasonLabel: previousSeasonLabel, malId: anime.malId, discordId: vote.discordId });
			if (previousEpisodes > 0) {
				setEpisodesWatched({
					seasonLabel,
					malId: anime.malId,
					discordId: vote.discordId,
					displayName: vote.displayName,
					episodesWatched: previousEpisodes,
				});
			}
		} catch (err) {
			console.error(`[temporada] no pude trasladar el voto de "${vote.displayName}" para "${anime.title}":`, err.message);
		}
	}
	if (previousVotes.length > 0) {
		console.log(`[temporada] "${anime.title}": ${previousVotes.length} voto(s) trasladado(s) de la temporada anterior`);
	}
}

function voterListText(voterNames) {
	return voterNames.length > 0 ? voterNames.map((name) => `**${name}**`).join(', ') : 'nadie con el rol de votación todavía';
}

function progressBar(current, total, length = 20) {
	const filled = total > 0 ? Math.round((current / total) * length) : 0;
	const pct = total > 0 ? Math.round((current / total) * 100) : 0;
	return `${'▓'.repeat(filled)}${'░'.repeat(length - filled)} ${current}/${total} (${pct}%)`;
}

function carryoverNoteText(carryoverCount) {
	return carryoverCount > 0
		? ` Además, agregué **${carryoverCount}** anime(s) que seguían en emisión de la temporada anterior a "CONTINUAN".`
		: '';
}

function forumChannelSlug(seasonLabel) {
	return seasonLabel
		.toLowerCase()
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

// Trae TODOS los hilos archivados de un foro, paginando: fetchArchived solo devuelve una tanda por
// llamada, así que hay que seguir pidiendo con `before` hasta que Discord diga que no hay más.
async function fetchAllArchivedThreads(forumChannel) {
	const all = [];
	let before;
	for (;;) {
		const page = await forumChannel.threads.fetchArchived({ limit: 100, before });
		if (page.threads.size === 0) break;
		all.push(...page.threads.values());
		if (!page.hasMore) break;
		before = page.threads.last().id;
	}
	return all;
}

// Borra todos los hilos (activos y archivados) de un foro, para dejarlo limpio antes de volver a
// llenarlo con la temporada nueva.
async function emptyForumChannel(forumChannel) {
	const active = await forumChannel.threads.fetchActive();
	const archived = await fetchAllArchivedThreads(forumChannel);
	const threads = [...active.threads.values(), ...archived];
	if (threads.length === 0) return;

	console.log(`[temporada-foro] vaciando #${forumChannel.name}: borrando ${threads.length} hilo(s) viejo(s)...`);
	const results = await Promise.allSettled(threads.map((thread) => thread.delete('Vaciando el foro para la nueva temporada')));
	const failed = results.filter((result) => result.status === 'rejected').length;
	if (failed > 0) {
		console.error(`[temporada-foro] no pude borrar ${failed}/${threads.length} hilo(s) viejo(s) de #${forumChannel.name}`);
	}
}

// Busca el canal de foro ya creado para este servidor (lo recordamos en la DB local, no por
// nombre). Si ya existe, lo reutiliza: lo vacía de hilos viejos y lo renombra si la temporada
// cambió, en vez de borrar y recrear el canal (así se conservan permisos, webhooks, etc.). Si no
// hay ninguno, crea uno con las etiquetas que distinguen nuevo/secuela/CONTINUAN y en vista de
// galería.
async function getOrCreateForumChannel(guild, seasonLabel, parentId) {
	const stored = getForumChannel(guild.id);
	const desiredName = forumChannelSlug(seasonLabel);
	const desiredTopic = `Votación de ${seasonLabel}`;

	if (stored) {
		const existing = await guild.channels.fetch(stored.channelId).catch(() => null);
		if (existing) {
			console.log(`[temporada-foro] reutilizando canal existente #${existing.name} para "${seasonLabel}"`);
			await emptyForumChannel(existing);

			if (existing.name !== desiredName) {
				console.log(`[temporada-foro] renombrando #${existing.name} -> #${desiredName}`);
				await existing.setName(desiredName).catch((err) => console.error(`[temporada-foro] no pude renombrar el canal:`, err.message));
			}
			if (existing.topic !== desiredTopic) {
				await existing.setTopic(desiredTopic).catch(() => {});
			}
			if (existing.defaultForumLayout !== ForumLayoutType.GalleryView) {
				await existing.setDefaultForumLayout(ForumLayoutType.GalleryView).catch(() => {});
			}

			setForumChannel({ guildId: guild.id, channelId: existing.id, seasonLabel });
			return existing;
		}
	}

	console.log(`[temporada-foro] creando canal de foro nuevo para "${seasonLabel}"...`);
	const forumChannel = await guild.channels.create({
		name: desiredName,
		type: ChannelType.GuildForum,
		parent: parentId ?? undefined,
		topic: desiredTopic,
		defaultForumLayout: ForumLayoutType.GalleryView,
		availableTags: FORUM_TAG_NAMES.map((tagName) => ({ name: tagName })),
	});

	setForumChannel({ guildId: guild.id, channelId: forumChannel.id, seasonLabel });
	return forumChannel;
}

function tagIdFor(forumChannel, anime) {
	const tagName = anime.isCarryover ? 'CONTINUAN' : anime.isSequel ? 'Secuela' : 'Nuevo';
	return forumChannel.availableTags.find((tag) => tag.name === tagName)?.id;
}

// Crea (o reusa) un canal de foro para la temporada y publica un hilo por anime, cada uno con su
// embed y sus botones de voto en el mensaje inicial: todos los hilos quedan visibles a la vez en el
// canal, sin necesidad de un mensaje único con Anterior/Siguiente.
async function publishSeasonForum({ interaction, respond, year, season, nombreOverride, voterNames }) {
	const guild = interaction.guild ?? (await interaction.client.guilds.fetch(interaction.guildId));
	const commandChannel = interaction.channel ?? (await interaction.client.channels.fetch(interaction.channelId));

	const prepared = await prepareSeason({ guildId: guild.id, year, season, nombreOverride });
	if (!prepared) {
		await respond('No encontré animes para esa temporada.');
		return;
	}
	const { seasonLabel, anime, carryoverCount } = prepared;

	let forumChannel;
	try {
		forumChannel = await getOrCreateForumChannel(guild, seasonLabel, commandChannel.parentId);
	} catch (err) {
		await respond(`No pude crear el canal de foro (¿tengo permiso de "Gestionar canales"?): ${err.message}`);
		return;
	}

	const introText = `Publicando animes de **${seasonLabel}** como hilos en ${forumChannel}. Los votos se guardarán en la pestaña "${seasonLabel}" de la sheet.${carryoverNoteText(carryoverCount)}\nVan a votar: ${voterListText(voterNames)}.`;

	await respond(`${introText}\n\n${progressBar(0, anime.length)}`);

	console.log(`[temporada-foro] canal listo: #${forumChannel.name} (${forumChannel.id}). Creando ${anime.length} hilos...`);

	// Discord ordena los posts del foro por actividad más reciente primero: el último hilo creado
	// queda arriba. Creamos en orden inverso para que el anime más importante (anime[0], el más
	// popular según Jikan) sea el último en crearse y termine arriba de todo. Se manda cada tanda en
	// paralelo (en vez de uno por uno con pausa fija) para que tarde mucho menos; dentro de una misma
	// tanda el orden de llegada puede variar un poco, pero entre tandas se respeta.
	let created = 0;
	const reversed = [...anime].reverse();
	const batches = chunk(reversed, FORUM_THREAD_CONCURRENCY);
	let lastProgressUpdateAt = 0;

	for (const [batchIndex, batch] of batches.entries()) {
		const batchStartedAt = Date.now();
		const results = await Promise.allSettled(
			batch.map(async (entry) => {
				const voteState = getVoteState({ seasonLabel, malId: entry.malId });
				await forumChannel.threads.create({
					name: entry.title.slice(0, 100),
					message: {
						embeds: [buildAnimeEmbed(entry, { voteState })],
						components: buildVoteRow(seasonLabel, entry.malId, { voteState }),
						// Publicar 70+ hilos de una sentada no debería mandarle una notificación push a todo
						// el que tenga el canal en "Todos los mensajes"; el mensaje sigue apareciendo igual.
						flags: MessageFlags.SuppressNotifications,
					},
					appliedTags: [tagIdFor(forumChannel, entry)].filter(Boolean),
				});
				return entry.title;
			}),
		);

		for (const result of results) {
			if (result.status === 'fulfilled') {
				created += 1;
			} else {
				console.error(`[temporada-foro] no pude crear un hilo:`, result.reason?.message ?? result.reason);
			}
		}

		const batchMs = Date.now() - batchStartedAt;
		console.log(`[temporada-foro] tanda ${batchIndex + 1}/${batches.length}: ${created}/${reversed.length} hilos creados hasta ahora (${batchMs}ms)`);

		const isLast = batchIndex === batches.length - 1;
		if (batchMs > 10_000) {
			console.error(`[temporada-foro] la tanda ${batchIndex + 1} tardó ${Math.round(batchMs / 1000)}s — probablemente Discord aplicó un rate limit largo`);
			await respond(
				`${introText}\n\n${progressBar(created, reversed.length)}\n⚠️ Va lento porque Discord está frenando la creación de hilos (no es que el bot se colgó).`,
			).catch(() => {});
			lastProgressUpdateAt = Date.now();
		} else if (!isLast && Date.now() - lastProgressUpdateAt > 5_000) {
			await respond(`${introText}\n\n${progressBar(created, reversed.length)}`).catch(() => {});
			lastProgressUpdateAt = Date.now();
		}

		await sleep(FORUM_BATCH_DELAY_MS);
	}

	await respond(`${introText}\n\n${progressBar(created, anime.length)}\n✅ Listo, ya está todo publicado.`).catch(() => {});

	console.log(`[temporada-foro] listo: ${created}/${anime.length} hilos creados en "${seasonLabel}"`);
}

module.exports = {
	buildTemporadaCommandData,
	runTemporadaCommand,
	handleSeasonSelect,
	handleSeasonConfirm,
};
