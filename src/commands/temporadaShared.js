const { SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ForumLayoutType } = require('discord.js');
const { getSeasonAnime, getAnimeById } = require('../services/jikan');
const { ensureSeasonTab, ensureAnimeColumn, getPreviousTabMalIds } = require('../services/sheets');
const { upsertAnime, getVoteState, getForumChannel, setForumChannel } = require('../services/db');
const { defaultSeasonLabel, slugForCustomId, JIKAN_SEASON_TO_ES, seasonAtOffset } = require('../seasonLabel');
const { rememberAnime, rememberSeasonLabel, rememberSeasonOrder } = require('../seasonCache');
const { buildAnimeEmbed, buildVoteRow } = require('../components');

const VOTE_ROLE_ID = process.env.VOTE_ROLE_ID;
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

// Define las opciones comunes a /temporada y /temporada-foro; cada comando le pone su propio
// nombre/descripción. La temporada siempre se elige con el selector; el único parámetro manual es
// el nombre de la pestaña de la sheet, por si hay que pisar el que se calcula automáticamente.
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

	if (VOTE_ROLE_ID && interaction.guild) {
		await interaction.guild.members.fetch();
		const role = interaction.guild.roles.cache.get(VOTE_ROLE_ID);
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

// Punto de entrada compartido por /temporada y /temporada-foro: siempre muestra el selector de
// temporada y al confirmar llama a `publish` con el destino ya resuelto.
async function runTemporadaCommand(interaction, mode) {
	await interaction.deferReply();

	const nombreOverride = interaction.options.getString('nombre');
	const voterNames = await getVoterNames(interaction);

	await interaction.editReply({ content: '¿Qué temporada quieres publicar?', components: [buildSeasonSelectRow()] });
	const message = await interaction.fetchReply();
	interaction.client.seasonPickerCache = interaction.client.seasonPickerCache ?? new Map();
	interaction.client.seasonPickerCache.set(message.id, { nombreOverride, voterNames, mode });
}

// Llamada desde interactions.js tras elegir una opción del selector: muestra un botón de
// confirmación antes de publicar nada, por si el usuario se equivocó de temporada.
async function handleSeasonSelect(interaction, year, season) {
	await interaction.update({
		content: `Vas a publicar **${seasonOptionLabel({ year, season })}**. ¿Confirmas?`,
		components: [buildConfirmRow(year, season)],
	});
}

// Llamada desde interactions.js al pulsar "Confirmar": recupera el nombre/voters/modo guardados al
// abrir el selector (van ligados al mensaje, no a esta nueva interacción) y publica la temporada.
async function handleSeasonConfirm(interaction, year, season) {
	const pending = interaction.client.seasonPickerCache?.get(interaction.message.id) ?? {};
	interaction.client.seasonPickerCache?.delete(interaction.message.id);

	await interaction.update({ content: `Publicando **${seasonOptionLabel({ year, season })}**...`, components: [] });

	await publish(pending.mode ?? 'carousel', {
		interaction,
		respond: (content) => interaction.editReply(content),
		year: Number(year),
		season,
		nombreOverride: pending.nombreOverride,
		voterNames: pending.voterNames ?? [],
	});
}

function publish(mode, args) {
	return mode === 'foro' ? publishSeasonForum(args) : publishSeasonCarousel(args);
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
	rememberSeasonOrder(seasonSlug, anime.map((entry) => entry.malId));

	for (const entry of anime) {
		upsertAnime({ malId: entry.malId, seasonLabel, guildId, title: entry.title, url: entry.url, broadcastDay: entry.broadcastDay });
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
			await ensureAnimeColumn(seasonLabel, { ...fullAnime, isCarryover: true });
			upsertAnime({ malId: fullAnime.malId, seasonLabel, guildId, title: fullAnime.title, url: fullAnime.url, broadcastDay: fullAnime.broadcastDay });
			console.log(`[temporada] carryover: "${fullAnime.title}" sigue en emisión, agregado a CONTINUAN`);
			count += 1;
		} catch (err) {
			console.error(`[temporada] no pude revisar el malId ${malId} para carryover:`, err.message);
		}
	}
	return count;
}

function voterListText(voterNames) {
	return voterNames.length > 0 ? voterNames.map((name) => `**${name}**`).join(', ') : 'nadie con el rol de votación todavía';
}

function carryoverNoteText(carryoverCount) {
	return carryoverCount > 0
		? ` Además, agregué **${carryoverCount}** anime(s) que seguían en emisión de la temporada anterior a "CONTINUAN".`
		: '';
}

// Modo carrusel: un solo mensaje en el canal, mostrando un anime a la vez con botones de
// navegación (comportamiento original de /temporada).
async function publishSeasonCarousel({ interaction, respond, year, season, nombreOverride, voterNames }) {
	const channel = interaction.channel ?? (await interaction.client.channels.fetch(interaction.channelId));
	const guildId = channel.guild.id;

	const prepared = await prepareSeason({ guildId, year, season, nombreOverride });
	if (!prepared) {
		await respond('No encontré animes para esa temporada.');
		return;
	}
	const { seasonLabel, anime, carryoverCount } = prepared;

	await respond(
		`Publicando **${anime.length}** animes de **${seasonLabel}** en este canal. Los votos se guardarán en la pestaña "${seasonLabel}" de la sheet.${carryoverNoteText(carryoverCount)}\nVan a votar: ${voterListText(voterNames)}.`,
	);

	const first = anime[0];
	const voteState = getVoteState({ seasonLabel, malId: first.malId });
	await channel.send({
		embeds: [buildAnimeEmbed(first, { index: 0, total: anime.length, voteState })],
		components: buildVoteRow(seasonLabel, first.malId, { index: 0, total: anime.length, voteState }),
	});
}

function forumChannelSlug(seasonLabel) {
	return seasonLabel
		.toLowerCase()
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

// Busca el canal de foro ya creado para esta temporada (lo recordamos por servidor en la DB local,
// no por nombre); si el foro guardado es de una temporada DISTINTA, lo borra antes de crear el
// nuevo, para no dejar canales de temporadas viejas acumulándose. Si no hay ninguno, crea uno con
// las etiquetas que distinguen nuevo/secuela/CONTINUAN y en vista de galería.
async function getOrCreateForumChannel(guild, seasonLabel, parentId) {
	const stored = getForumChannel(guild.id);

	if (stored && stored.seasonLabel === seasonLabel) {
		const existing = await guild.channels.fetch(stored.channelId).catch(() => null);
		if (existing) {
			console.log(`[temporada-foro] reutilizando canal existente #${existing.name} para "${seasonLabel}"`);
			if (existing.defaultForumLayout !== ForumLayoutType.GalleryView) {
				await existing.setDefaultForumLayout(ForumLayoutType.GalleryView).catch(() => {});
			}
			return existing;
		}
	}

	if (stored && stored.seasonLabel !== seasonLabel) {
		const old = await guild.channels.fetch(stored.channelId).catch(() => null);
		if (old) {
			console.log(`[temporada-foro] borrando canal viejo #${old.name} (temporada "${stored.seasonLabel}") para reemplazarlo por "${seasonLabel}"`);
			await old.delete(`Reemplazado por el foro de ${seasonLabel}`).catch((err) =>
				console.error(`[temporada-foro] no pude borrar el canal viejo:`, err.message),
			);
		}
	}

	console.log(`[temporada-foro] creando canal de foro nuevo para "${seasonLabel}"...`);
	const forumChannel = await guild.channels.create({
		name: forumChannelSlug(seasonLabel),
		type: ChannelType.GuildForum,
		parent: parentId ?? undefined,
		topic: `Votación de ${seasonLabel}`,
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

// Modo foro: crea (o reusa) un canal de foro para la temporada y publica un hilo por anime, cada
// uno con su embed y sus botones de voto en el mensaje inicial. Sin Anterior/Siguiente: todos los
// hilos quedan visibles a la vez en el canal.
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

	await respond(
		`Publicando **${anime.length}** animes de **${seasonLabel}** como hilos en ${forumChannel}. Los votos se guardarán en la pestaña "${seasonLabel}" de la sheet.${carryoverNoteText(carryoverCount)}\nVan a votar: ${voterListText(voterNames)}.`,
	);

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
						components: buildVoteRow(seasonLabel, entry.malId, { voteState, includeNav: false }),
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
				`Sigo publicando, va lento porque Discord está frenando la creación de hilos (no es que el bot se colgó) — ${created}/${reversed.length} hilos creados hasta ahora.`,
			).catch(() => {});
			lastProgressUpdateAt = Date.now();
		} else if (!isLast && Date.now() - lastProgressUpdateAt > 5_000) {
			await respond(`Publicando hilos... ${created}/${reversed.length} creados hasta ahora.`).catch(() => {});
			lastProgressUpdateAt = Date.now();
		}

		await sleep(FORUM_BATCH_DELAY_MS);
	}

	await respond(`Listo, los ${created}/${anime.length} hilos de **${seasonLabel}** ya están publicados en ${forumChannel}.`).catch(() => {});

	console.log(`[temporada-foro] listo: ${created}/${anime.length} hilos creados en "${seasonLabel}"`);
}

module.exports = {
	buildTemporadaCommandData,
	runTemporadaCommand,
	handleSeasonSelect,
	handleSeasonConfirm,
	publish,
};
