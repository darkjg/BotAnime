const { SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
	getActiveSeason,
	getAllAnime,
	getAnimeForSeason,
	getVotesForSeason,
	getUserVote,
	getEpisodesWatched,
	getLastNotifiedAv1Episode,
	getEpisodeLinkMessage,
	getAv1ForumThread,
	getAv1ForumThreadAnySeason,
	getDisplayTitle,
} = require('../services/db');
const { autoCleanupReply } = require('../ephemeral');
const { paginateBlocks } = require('../pagination');

const data = new SlashCommandBuilder()
	.setName('pendientes')
	.setDescription('Ver capítulos pendientes (y en cuáles coinciden para verlos juntos)');

const PAGE_CLEANUP_DELAY_MS = 5 * 60_000; // más que el default: da tiempo a navegar entre páginas
const MAX_CHARS_PER_PAGE = 1500;

// "Ver" un anime = votar verde o naranja, igual que /en-comun.
function isWatching(seasonLabel, malId, discordId) {
	const vote = getUserVote({ seasonLabel, malId, discordId });
	return Boolean(vote) && (vote.voteType === 'verde' || vote.voteType === 'naranja');
}

function episodeRange(from, to) {
	return from === to ? `cap. ${from}` : `caps. ${from}-${to}`;
}

// Link al mensaje del hilo de foro con las descargas del último capítulo detectado. Preferimos el
// mensaje puntual de ese capítulo (lleva directo ahí), pero episode_link_messages se poda a los 4 días
// (ver PROVIDER_RECHECK_MAX_AGE_MS en scheduler.js) o puede no haberse llegado a publicar nunca (ver el
// bug real de getDownloadLinks en animeav1.js, corregido 2026-09-11) — si no está, cae al link del
// hilo en general, que siempre existe mientras el anime tenga hilo.
function forumLinkFor({ seasonLabel, guildId, malId, episode }) {
	const message = getEpisodeLinkMessage({ guildId, seasonLabel, malId, episode });
	if (message) return `https://discord.com/channels/${guildId}/${message.threadId}/${message.messageId}`;

	// Fallback: si el carryover a esta temporada no llegó a crear hilo acá (ver getAv1ForumThreadAnySeason
	// en db.js), usa el hilo real de otra temporada en vez de mostrar el título sin ningún link.
	const threadId = getAv1ForumThread({ guildId, seasonLabel, malId }) ?? getAv1ForumThreadAnySeason({ guildId, malId });
	return threadId ? `https://discord.com/channels/${guildId}/${threadId}` : null;
}

// Todas las temporadas que este guild publicó alguna vez (no solo la activa): getAllAnime no filtra
// por temporada, así que de ahí sale la lista completa de seasonLabel que hay que revisar.
function getAllSeasonLabelsForGuild(guildId) {
	return [...new Set(getAllAnime().filter((a) => a.guildId === guildId).map((a) => a.seasonLabel))];
}

// Cruza a quiénes de `people` les quedan capítulos pendientes de un anime puntual (contra el último
// episodio que animeav1 detectó, ver getLastNotifiedAv1Episode) y los agrupa por el capítulo exacto
// por el que van: si dos o más van por el mismo, quedan "en común" (podrían verlos juntos arrancando
// del mismo punto); si alguien va por un capítulo distinto al resto, su pendiente queda en su propia
// sección individual. Acumula en `individual`/`common` (no devuelve nada nuevo) para poder llamarse una
// vez por cada temporada sin perder lo ya encontrado en las anteriores. `seenMalIds` evita mostrar dos
// veces un anime que sigue de una temporada a otra (carryover): cada temporada guarda su propio
// progreso/último-detectado por separado para el mismo malId, así que sin esto "One Piece" saldría una
// vez por cada temporada donde está registrado.
function addPendingForAnime({ seasonLabel, guildId, anime, people, individual, common, seenMalIds }) {
	if (seenMalIds.has(anime.malId)) return;

	const lastNotified = getLastNotifiedAv1Episode({ seasonLabel, malId: anime.malId, guildId });
	if (!lastNotified) return; // animeav1 todavía no detectó ningún episodio de este anime, nada que marcar
	seenMalIds.add(anime.malId); // a partir de acá, esta temporada es la que manda para este malId

	const watchers = people
		.filter((p) => isWatching(seasonLabel, anime.malId, p.id))
		.map((p) => ({ ...p, episodesWatched: getEpisodesWatched({ seasonLabel, malId: anime.malId, discordId: p.id }) }))
		.filter((p) => p.episodesWatched < lastNotified);
	if (watchers.length === 0) return;

	const link = forumLinkFor({ seasonLabel, guildId, malId: anime.malId, episode: lastNotified });

	const byEpisode = new Map();
	for (const w of watchers) {
		if (!byEpisode.has(w.episodesWatched)) byEpisode.set(w.episodesWatched, []);
		byEpisode.get(w.episodesWatched).push(w);
	}

	for (const [watchedEp, group] of byEpisode) {
		const entry = { title: getDisplayTitle(anime), from: watchedEp + 1, to: lastNotified, link };
		if (group.length > 1) {
			common.push({ ...entry, people: group.map((g) => g.displayName) });
		} else {
			individual.get(group[0].id).push(entry);
		}
	}
}

// Revisa TODAS las temporadas que tuvo el servidor, no solo la activa — un pendiente de una temporada
// vieja (algo que quedó sin terminar y no se llevó como carryover a la actual) antes no aparecía acá.
// La activa se revisa primero (es la que tiene los datos más al día) y seenMalIds evita que un anime
// que sigue de una temporada a otra (carryover) salga duplicado con los números de cada una.
function buildPendingReport({ guildId, people }) {
	const individual = new Map(people.map((p) => [p.id, []]));
	const common = [];
	const seenMalIds = new Set();

	const activeSeasonLabel = getActiveSeason(guildId);
	const seasonLabels = getAllSeasonLabelsForGuild(guildId).sort((a, b) => (a === activeSeasonLabel ? -1 : b === activeSeasonLabel ? 1 : 0));

	for (const seasonLabel of seasonLabels) {
		const tracked = getAnimeForSeason(seasonLabel).filter((a) => a.guildId === guildId);
		for (const anime of tracked) {
			addPendingForAnime({ seasonLabel, guildId, anime, people, individual, common, seenMalIds });
		}
	}

	return { individual, common };
}

// Título con link al mensaje del último capítulo en el foro (si lo encontramos, ver forumLinkFor);
// texto plano si no hay ningún link disponible.
function titleText(it) {
	return it.link ? `[${it.title}](${it.link})` : it.title;
}

// Un bloque por persona (lo que a ella le falta) y uno final para "en común", igual que /en-comun: así
// paginateBlocks puede repartirlos entre páginas sin cortar la sección de nadie a la mitad.
function buildBlocks(people, { individual, common }) {
	const multiplePeople = people.length > 1;

	const blocks = people.map((p) => {
		const header = multiplePeople ? `**Individual — ${p.displayName}**` : `**Pendientes de ${p.displayName}**`;
		const items = individual.get(p.id);
		const body = items.length === 0 ? 'Sin pendientes individuales.' : items.map((it) => `• ${titleText(it)}: ${episodeRange(it.from, it.to)}`).join('\n');
		return `${header}\n${body}`;
	});

	if (multiplePeople) {
		const body =
			common.length === 0
				? 'Nadie coincide todavía en el mismo capítulo pendiente.'
				: common.map((it) => `• ${titleText(it)} (${it.people.join(', ')}): ${episodeRange(it.from, it.to)}`).join('\n');
		blocks.push(`**En común**\n${body}`);
	}

	return blocks;
}

function buildPageContent(pages, pageIndex) {
	const pageNote = pages.length > 1 ? `_(página ${pageIndex + 1}/${pages.length})_\n\n` : '';
	return `${pageNote}${pages[pageIndex]}`;
}

function buildPageComponents(token, pageIndex, totalPages) {
	if (totalPages <= 1) return [];
	return [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`pendientespage:${token}:${pageIndex - 1}`)
				.setLabel('◀ Anterior')
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(pageIndex === 0),
			new ButtonBuilder()
				.setCustomId(`pendientespage:${token}:${pageIndex + 1}`)
				.setLabel('Siguiente ▶')
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(pageIndex === totalPages - 1),
		),
	];
}

async function showPending(interaction, people, { isUpdate = false } = {}) {
	const report = buildPendingReport({ guildId: interaction.guildId, people });
	const pages = paginateBlocks(buildBlocks(people, report), MAX_CHARS_PER_PAGE);

	interaction.client.pendientesPagesCache = interaction.client.pendientesPagesCache ?? new Map();

	if (isUpdate) {
		const token = interaction.message.id;
		await interaction.update({ content: buildPageContent(pages, 0), components: buildPageComponents(token, 0, pages.length) });
		interaction.client.pendientesPagesCache.set(token, pages);
	} else {
		// No hay message.id todavía antes de responder: se manda sin botones y, si hace falta paginar,
		// se agregan en una segunda edición ya con el id real de la respuesta como token.
		await interaction.reply({ content: buildPageContent(pages, 0), ephemeral: true });
		if (pages.length > 1) {
			const reply = await interaction.fetchReply();
			interaction.client.pendientesPagesCache.set(reply.id, pages);
			await interaction.editReply({ components: buildPageComponents(reply.id, 0, pages.length) });
		}
	}
	autoCleanupReply(interaction, pages.length > 1 ? PAGE_CLEANUP_DELAY_MS : undefined);
}

async function handlePageButton(interaction, token, pageIndexRaw) {
	const pages = interaction.client.pendientesPagesCache?.get(token);
	if (!pages) {
		await interaction.update({ content: 'Esto ya expiró, usa /pendientes de nuevo.', components: [] });
		autoCleanupReply(interaction);
		return;
	}

	const pageIndex = Math.max(0, Math.min(pages.length - 1, Number(pageIndexRaw)));
	await interaction.update({ content: buildPageContent(pages, pageIndex), components: buildPageComponents(token, pageIndex, pages.length) });
	autoCleanupReply(interaction, PAGE_CLEANUP_DELAY_MS);
}

async function execute(interaction) {
	const seasonLabels = getAllSeasonLabelsForGuild(interaction.guildId);
	if (seasonLabels.length === 0) {
		await interaction.reply({ content: 'Este servidor todavía no publicó ninguna temporada.', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}

	if (interaction.guild.members.cache.size < interaction.guild.memberCount) {
		try {
			await interaction.guild.members.fetch();
		} catch (err) {
			console.error('[pendientes] no pude refrescar la lista de miembros:', err.message);
		}
	}

	// Mismo criterio que /en-comun: solo ofrece gente con al menos un voto verde/naranja, cruzado contra
	// la caché de miembros de este guild — pero en TODAS las temporadas, no solo la activa, para poder
	// ofrecer como comparación a alguien que solo votó en una temporada vieja.
	const votes = seasonLabels.flatMap((s) => getVotesForSeason(s)).filter((v) => v.voteType === 'verde' || v.voteType === 'naranja');
	const uniqueIds = [...new Set(votes.map((v) => v.discordId))].filter((id) => id !== interaction.user.id);
	const eligible = uniqueIds
		.map((id) => interaction.guild.members.cache.get(id))
		.filter(Boolean)
		.map((member) => ({ id: member.id, displayName: member.displayName }))
		.sort((a, b) => a.displayName.localeCompare(b.displayName));

	// Sin nadie más con quien comparar, directamente muestra los pendientes propios.
	if (eligible.length === 0) {
		await showPending(interaction, [{ id: interaction.user.id, displayName: interaction.member.displayName }]);
		return;
	}

	// Discord no deja más de 25 opciones por selector. Un select con minValues 0 no se puede "confirmar"
	// vacío desde la UI (no hay botón de submit para un select), así que el caso "solo lo mío" necesita
	// un botón aparte en vez de depender de dejar el selector sin elegir nada.
	const truncated = eligible.length > 25;
	const select = new StringSelectMenuBuilder()
		.setCustomId('pendientes')
		.setPlaceholder('Elegí con quién comparar')
		.setMinValues(1)
		.setMaxValues(Math.min(eligible.length, 25))
		.addOptions(eligible.slice(0, 25).map((p) => ({ label: p.displayName, value: p.id })));

	const soloButton = new ButtonBuilder().setCustomId('pendientessolo').setLabel('Ver solo lo mío').setStyle(ButtonStyle.Secondary);

	await interaction.reply({
		content: `¿Con quién comparamos los pendientes?${truncated ? ' (mostrando los primeros 25 con votos)' : ''}`,
		components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(soloButton)],
		ephemeral: true,
	});
}

async function handleSelect(interaction) {
	const people = [{ id: interaction.user.id, displayName: interaction.member.displayName }];
	for (const id of interaction.values) {
		const member = interaction.guild.members.cache.get(id);
		people.push({ id, displayName: member?.displayName ?? id });
	}

	await showPending(interaction, people, { isUpdate: true });
}

async function handleSoloButton(interaction) {
	await showPending(interaction, [{ id: interaction.user.id, displayName: interaction.member.displayName }], { isUpdate: true });
}

module.exports = { data, execute, handleSelect, handleSoloButton, handlePageButton };
