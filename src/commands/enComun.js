const { SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
	getActiveSeason,
	getAnimeForSeason,
	getVotesForSeason,
	getUserVote,
	getEpisodesWatched,
	getLastNotifiedAv1Episode,
	getDisplayTitle,
} = require('../services/db');
const { autoCleanupReply } = require('../ephemeral');
const { paginateBlocks } = require('../pagination');

const data = new SlashCommandBuilder()
	.setName('en-comun')
	.setDescription('Elegí con quién comparar para ver qué animes de la temporada están viendo juntos');

const PAGE_CLEANUP_DELAY_MS = 5 * 60_000; // más que el default: da tiempo a navegar entre páginas
const MAX_CHARS_PER_PAGE = 1500;

// "Ver" un anime = votar verde o naranja, igual que getWatchers (services/db.js) usa para los avisos.
function isWatching(seasonLabel, malId, discordId) {
	const vote = getUserVote({ seasonLabel, malId, discordId });
	return Boolean(vote) && (vote.voteType === 'verde' || vote.voteType === 'naranja');
}

async function execute(interaction) {
	const seasonLabel = getActiveSeason(interaction.guildId);
	if (!seasonLabel) {
		await interaction.reply({ content: 'No hay una temporada activa en este servidor.', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}

	if (interaction.guild.members.cache.size < interaction.guild.memberCount) {
		try {
			await interaction.guild.members.fetch();
		} catch (err) {
			console.error('[en-comun] no pude refrescar la lista de miembros:', err.message);
		}
	}

	// Solo ofrece a quien tenga al menos un voto verde/naranja en la temporada activa: comparar con
	// alguien sin votos siempre daría una lista vacía. getVotesForSeason no filtra por guild, así que se
	// cruza contra la caché de miembros de este guild para no ofrecer gente de otro servidor.
	const votes = getVotesForSeason(seasonLabel).filter((v) => v.voteType === 'verde' || v.voteType === 'naranja');
	const uniqueIds = [...new Set(votes.map((v) => v.discordId))].filter((id) => id !== interaction.user.id);
	const eligible = uniqueIds
		.map((id) => interaction.guild.members.cache.get(id))
		.filter(Boolean)
		.map((member) => ({ id: member.id, displayName: member.displayName }))
		.sort((a, b) => a.displayName.localeCompare(b.displayName));

	if (eligible.length === 0) {
		await interaction.reply({ content: 'Nadie más votó en esta temporada todavía.', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}

	// Discord no deja más de 25 opciones por selector.
	const truncated = eligible.length > 25;
	const select = new StringSelectMenuBuilder()
		.setCustomId('encomun')
		.setPlaceholder('Elegí con quién comparar')
		.setMinValues(1)
		.setMaxValues(Math.min(eligible.length, 25))
		.addOptions(eligible.slice(0, 25).map((p) => ({ label: p.displayName, value: p.id })));

	await interaction.reply({
		content: `¿Con quién comparamos?${truncated ? ' (mostrando los primeros 25 con votos)' : ''}`,
		components: [new ActionRowBuilder().addComponents(select)],
		ephemeral: true,
	});
}

// Texto de "cuánto falta" dado el último episodio detectado por animeav1 y el capítulo por el que va
// alguien. 'al día' si ya alcanzó ese último episodio.
function rangeText(lastNotified, watched) {
	if (watched >= lastNotified) return 'al día';
	return watched + 1 === lastNotified ? `cap. ${lastNotified}` : `caps. ${watched + 1}-${lastNotified}`;
}

// Capítulos que le faltan a esa persona puntual para este anime, contra el último episodio que
// animeav1 detectó (ver getLastNotifiedAv1Episode, misma fuente que usa /pendientes). null si
// animeav1 todavía no detectó ningún episodio (no hay con qué comparar).
function pendingText(seasonLabel, guildId, malId, discordId) {
	const lastNotified = getLastNotifiedAv1Episode({ seasonLabel, malId, guildId });
	if (!lastNotified) return null;
	return rangeText(lastNotified, getEpisodesWatched({ seasonLabel, malId, discordId }));
}

// Línea de una sección individual: un solo dueño, así que solo hace falta su propio pendiente.
function individualLine(anime, seasonLabel, guildId, discordId) {
	const pending = pendingText(seasonLabel, guildId, anime.malId, discordId);
	const title = getDisplayTitle(anime);
	return pending ? `• ${title} — ${pending}` : `• ${title}`;
}

// Línea de la sección "en común": lo ve todo el grupo, pero cada quien puede ir por un capítulo
// distinto. En vez de repetir el nombre de cada persona en la línea, se muestra el pendiente del más
// atrasado del grupo (el capítulo desde el que arrancarían si lo vieran todos juntos).
function commonLine(anime, seasonLabel, guildId, people) {
	const title = getDisplayTitle(anime);
	const lastNotified = getLastNotifiedAv1Episode({ seasonLabel, malId: anime.malId, guildId });
	if (!lastNotified) return `• ${title}`;
	const minWatched = Math.min(...people.map((p) => getEpisodesWatched({ seasonLabel, malId: anime.malId, discordId: p.id })));
	return `• ${title} — ${rangeText(lastNotified, minWatched)}`;
}

// Cruza a cada anime de la temporada contra quiénes de `people` lo ven. Si TODOS lo ven, va al
// apartado "en común"; si no, va a la sección individual de cada uno de los que sí lo ven (un anime
// que comparten solo algunos, no todos, aparece en la sección de cada uno de esos algunos).
function compareAnime(tracked, seasonLabel, people) {
	const individualByPerson = new Map(people.map((p) => [p.id, []]));
	const common = [];

	for (const anime of tracked) {
		const watchers = people.filter((p) => isWatching(seasonLabel, anime.malId, p.id));
		if (watchers.length === 0) continue;

		if (watchers.length === people.length) {
			common.push(anime);
		} else {
			for (const w of watchers) individualByPerson.get(w.id).push(anime);
		}
	}

	return { individualByPerson, common };
}

// Arma un bloque de texto por persona (lo que ve que no ve todo el grupo) y uno final para lo que ve
// absolutamente todo el mundo. Se devuelven como bloques separados para que paginate() los agrupe sin
// cortar una sección de sesga a la mitad si hay más de una página.
function buildSections(people, { individualByPerson, common }, seasonLabel, guildId) {
	const blocks = people.map((p) => {
		const items = individualByPerson.get(p.id);
		const body =
			items.length > 0 ? items.map((anime) => individualLine(anime, seasonLabel, guildId, p.id)).join('\n') : '_Nada que no vea todo el grupo._';
		return `**Individual — ${p.displayName}**\n${body}`;
	});

	const commonBody =
		common.length > 0
			? common.map((anime) => commonLine(anime, seasonLabel, guildId, people)).join('\n')
			: 'Nadie del grupo tiene animes en común con todos todavía.';
	blocks.push(`**En común (todo el grupo)**\n${commonBody}`);

	return blocks;
}

function buildPageContent(header, pages, pageIndex) {
	const pageNote = pages.length > 1 ? ` (página ${pageIndex + 1}/${pages.length})` : '';
	return `${header}${pageNote}\n\n${pages[pageIndex]}`;
}

function buildPageComponents(token, pageIndex, totalPages) {
	if (totalPages <= 1) return [];
	return [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`encomunpage:${token}:${pageIndex - 1}`)
				.setLabel('◀ Anterior')
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(pageIndex === 0),
			new ButtonBuilder()
				.setCustomId(`encomunpage:${token}:${pageIndex + 1}`)
				.setLabel('Siguiente ▶')
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(pageIndex === totalPages - 1),
		),
	];
}

async function handleSelect(interaction) {
	const seasonLabel = getActiveSeason(interaction.guildId);
	if (!seasonLabel) {
		await interaction.update({ content: 'No hay una temporada activa en este servidor.', components: [] });
		autoCleanupReply(interaction);
		return;
	}

	const people = [{ id: interaction.user.id, displayName: interaction.member.displayName }];
	for (const id of interaction.values) {
		const member = interaction.guild.members.cache.get(id);
		people.push({ id, displayName: member?.displayName ?? id });
	}

	const tracked = getAnimeForSeason(seasonLabel).filter((a) => a.guildId === interaction.guildId);
	const comparison = compareAnime(tracked, seasonLabel, people);
	const pages = paginateBlocks(buildSections(people, comparison, seasonLabel, interaction.guildId), MAX_CHARS_PER_PAGE);

	const names = people.map((p) => `**${p.displayName}**`).join(', ');
	const header = `Animes de ${names} en **${seasonLabel}**:`;

	await interaction.update({ content: buildPageContent(header, pages, 0), components: buildPageComponents(interaction.message.id, 0, pages.length) });

	// Cacheado en memoria (se pierde en un reinicio, igual que trailerCache/episodeFlowCache): el
	// selector inicial y los botones de página siguen todos en la misma interacción ephemeral.
	interaction.client.enComunPagesCache = interaction.client.enComunPagesCache ?? new Map();
	interaction.client.enComunPagesCache.set(interaction.message.id, { header, pages });

	autoCleanupReply(interaction, pages.length > 1 ? PAGE_CLEANUP_DELAY_MS : undefined);
}

async function handlePageButton(interaction, token, pageIndexRaw) {
	const cached = interaction.client.enComunPagesCache?.get(token);
	if (!cached) {
		await interaction.update({ content: 'Esto ya expiró, usa /en-comun de nuevo.', components: [] });
		autoCleanupReply(interaction);
		return;
	}

	const pageIndex = Math.max(0, Math.min(cached.pages.length - 1, Number(pageIndexRaw)));
	await interaction.update({
		content: buildPageContent(cached.header, cached.pages, pageIndex),
		components: buildPageComponents(token, pageIndex, cached.pages.length),
	});
	autoCleanupReply(interaction, PAGE_CLEANUP_DELAY_MS);
}

module.exports = { data, execute, handleSelect, handlePageButton };
