const { SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ForumLayoutType } = require('discord.js');
const { getSeasonAnime, getAnimeById } = require('../services/jikan');
const { ensureSeasonTab, ensureAnimeColumn, getPreviousTabMalIds } = require('../services/sheets');
const { upsertAnime, getVoteState } = require('../services/db');
const { defaultSeasonLabel, slugForCustomId, ES_SEASON_TO_JIKAN, JIKAN_SEASON_TO_ES, nextSeason, seasonAtOffset } = require('../seasonLabel');
const { rememberAnime, rememberSeasonLabel, rememberSeasonOrder } = require('../seasonCache');
const { buildAnimeEmbed, buildVoteRow } = require('../components');

const VOTE_ROLE_ID = process.env.VOTE_ROLE_ID;
const MAX_MENTIONED_VOTERS = 10;
const SEASON_PICKER_RANGE = { from: -2, to: 4 }; // temporadas relativas a la actual que se muestran en el selector
const FORUM_TAG_NAMES = ['Nuevo', 'Secuela', 'CONTINUAN'];
const FORUM_THREAD_DELAY_MS = 400; // pequeña pausa entre hilos para no pegar contra el rate limit al crear ~70 de golpe

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Define las opciones comunes a /temporada y /temporada-foro; cada comando le pone su propio
// nombre/descripción.
function buildTemporadaCommandData(name, description) {
	const data = new SlashCommandBuilder()
		.setName(name)
		.setDescription(description)
		.addStringOption((option) =>
			option
				.setName('estacion')
				.setDescription('Estación a publicar. Si se omite junto con "anio", se abre un selector.')
				.setRequired(false)
				.addChoices(
					{ name: 'Invierno', value: 'invierno' },
					{ name: 'Primavera', value: 'primavera' },
					{ name: 'Verano', value: 'verano' },
					{ name: 'Otoño', value: 'otono' },
				),
		)
		.addIntegerOption((option) =>
			option.setName('anio').setDescription('Año de la temporada, ej: 2026. Si se omite, se usa el año actual.').setRequired(false),
		)
		.addStringOption((option) =>
			option
				.setName('nombre')
				.setDescription('Nombre de la pestaña de la sheet, ej: "Verano 2026". Si se omite, se calcula automáticamente.')
				.setRequired(false),
		);

	for (let i = 1; i <= MAX_MENTIONED_VOTERS; i += 1) {
		data.addUserOption((option) =>
			option.setName(`usuario${i}`).setDescription('Persona que va a votar en esta temporada').setRequired(false),
		);
	}

	return data;
}

async function getVoterNames(interaction) {
	const byId = new Map();

	if (VOTE_ROLE_ID && interaction.guild) {
		await interaction.guild.members.fetch();
		const role = interaction.guild.roles.cache.get(VOTE_ROLE_ID);
		role?.members.forEach((member) => byId.set(member.id, member.displayName));
	}

	for (let i = 1; i <= MAX_MENTIONED_VOTERS; i += 1) {
		const member = interaction.options.getMember(`usuario${i}`);
		const user = interaction.options.getUser(`usuario${i}`);
		if (user) byId.set(user.id, member?.displayName ?? user.username);
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

// Punto de entrada compartido por /temporada y /temporada-foro: resuelve año/estación (o muestra el
// selector si no se especificó ninguno) y al final llama a `publish` con el destino ya resuelto.
async function runTemporadaCommand(interaction, mode) {
	await interaction.deferReply();

	const estacionOpt = interaction.options.getString('estacion');
	const anioOpt = interaction.options.getInteger('anio');
	const nombreOverride = interaction.options.getString('nombre');
	const voterNames = await getVoterNames(interaction);

	if (!estacionOpt && !anioOpt) {
		await interaction.editReply({ content: '¿Qué temporada quieres publicar?', components: [buildSeasonSelectRow()] });
		const message = await interaction.fetchReply();
		interaction.client.seasonPickerCache = interaction.client.seasonPickerCache ?? new Map();
		interaction.client.seasonPickerCache.set(message.id, { nombreOverride, voterNames, mode });
		return;
	}

	const fallback = nextSeason();
	const season = estacionOpt ? ES_SEASON_TO_JIKAN[estacionOpt] : fallback.season;
	const year = anioOpt ?? (estacionOpt ? new Date().getFullYear() : fallback.year);

	await publish(mode, {
		interaction,
		respond: (content) => interaction.editReply(content),
		year,
		season,
		nombreOverride,
		voterNames,
	});
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
	const anime = await getSeasonAnime(year, season);
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

	return { seasonLabel, anime, carryoverCount };
}

// Animes que ya estaban en la pestaña anterior (en cualquiera de sus bloques) y que en MAL siguen
// "Currently Airing" se agregan directo al subgrupo CONTINUAN, sin esperar a que alguien vote.
// El orden por día de emisión dentro de la sheet lo decide ensureAnimeColumn al insertar.
async function addCarryoverAnime(seasonLabel, currentSeasonAnime, guildId) {
	const currentMalIds = new Set(currentSeasonAnime.map((a) => a.malId));
	const previousMalIds = await getPreviousTabMalIds(seasonLabel);

	let count = 0;
	for (const malId of previousMalIds) {
		if (currentMalIds.has(malId)) continue;
		try {
			const fullAnime = await getAnimeById(malId);
			if (fullAnime.status !== 'Currently Airing') continue;
			rememberAnime(fullAnime);
			await ensureAnimeColumn(seasonLabel, { ...fullAnime, isCarryover: true });
			upsertAnime({ malId: fullAnime.malId, seasonLabel, guildId, title: fullAnime.title, url: fullAnime.url, broadcastDay: fullAnime.broadcastDay });
			count += 1;
		} catch {
			// si Jikan falla para este anime en particular, lo saltamos sin romper el comando
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

// Busca un canal de foro ya creado para esta temporada (mismo nombre, mismo servidor); si no existe,
// lo crea con las etiquetas que distinguen nuevo/secuela/CONTINUAN y en vista de galería.
async function getOrCreateForumChannel(guild, seasonLabel, parentId) {
	const name = forumChannelSlug(seasonLabel);
	const existing = guild.channels.cache.find((ch) => ch.type === ChannelType.GuildForum && ch.name === name);
	if (existing) {
		if (existing.defaultForumLayout !== ForumLayoutType.GalleryView) {
			await existing.setDefaultForumLayout(ForumLayoutType.GalleryView).catch(() => {});
		}
		return existing;
	}

	return guild.channels.create({
		name,
		type: ChannelType.GuildForum,
		parent: parentId ?? undefined,
		topic: `Votación de ${seasonLabel}`,
		defaultForumLayout: ForumLayoutType.GalleryView,
		availableTags: FORUM_TAG_NAMES.map((tagName) => ({ name: tagName })),
	});
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

	// Discord ordena los posts del foro por actividad más reciente primero: el último hilo creado
	// queda arriba. Creamos en orden inverso para que el anime más importante (anime[0], el más
	// popular según Jikan) sea el último en crearse y termine arriba de todo.
	for (const entry of [...anime].reverse()) {
		try {
			const voteState = getVoteState({ seasonLabel, malId: entry.malId });
			await forumChannel.threads.create({
				name: entry.title.slice(0, 100),
				message: {
					embeds: [buildAnimeEmbed(entry, { voteState })],
					components: buildVoteRow(seasonLabel, entry.malId, { voteState, includeNav: false }),
				},
				appliedTags: [tagIdFor(forumChannel, entry)].filter(Boolean),
			});
		} catch (err) {
			console.error(`No pude crear el hilo para ${entry.title}:`, err.message);
		}
		await sleep(FORUM_THREAD_DELAY_MS);
	}
}

module.exports = {
	buildTemporadaCommandData,
	runTemporadaCommand,
	handleSeasonSelect,
	handleSeasonConfirm,
};
