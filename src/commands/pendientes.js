const { SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
	getActiveSeason,
	getAnimeForSeason,
	getVotesForSeason,
	getUserVote,
	getEpisodesWatched,
	getLastNotifiedAv1Episode,
} = require('../services/db');
const { autoCleanupReply } = require('../ephemeral');

const data = new SlashCommandBuilder()
	.setName('pendientes')
	.setDescription('Ver capítulos pendientes (y en cuáles coinciden para verlos juntos)');

// "Ver" un anime = votar verde o naranja, igual que /en-comun.
function isWatching(seasonLabel, malId, discordId) {
	const vote = getUserVote({ seasonLabel, malId, discordId });
	return Boolean(vote) && (vote.voteType === 'verde' || vote.voteType === 'naranja');
}

function episodeRange(from, to) {
	return from === to ? `cap. ${from}` : `caps. ${from}-${to}`;
}

// Para cada anime de la temporada, cruza a quiénes de `people` les quedan capítulos pendientes
// (contra el último episodio que animeav1 detectó, ver getLastNotifiedAv1Episode) y los agrupa por el
// capítulo exacto por el que van: si dos o más van por el mismo, quedan "en común" (podrían verlos
// juntos arrancando del mismo punto); si alguien va por un capítulo distinto al resto, su pendiente
// queda en su propia sección individual.
function buildPendingReport({ seasonLabel, guildId, people }) {
	const tracked = getAnimeForSeason(seasonLabel).filter((a) => a.guildId === guildId);

	const individual = new Map(people.map((p) => [p.id, []]));
	const common = [];

	for (const anime of tracked) {
		const lastNotified = getLastNotifiedAv1Episode({ seasonLabel, malId: anime.malId, guildId });
		if (!lastNotified) continue; // animeav1 todavía no detectó ningún episodio de este anime

		const watchers = people
			.filter((p) => isWatching(seasonLabel, anime.malId, p.id))
			.map((p) => ({ ...p, episodesWatched: getEpisodesWatched({ seasonLabel, malId: anime.malId, discordId: p.id }) }))
			.filter((p) => p.episodesWatched < lastNotified);
		if (watchers.length === 0) continue;

		const byEpisode = new Map();
		for (const w of watchers) {
			if (!byEpisode.has(w.episodesWatched)) byEpisode.set(w.episodesWatched, []);
			byEpisode.get(w.episodesWatched).push(w);
		}

		for (const [watchedEp, group] of byEpisode) {
			const entry = { title: anime.title, from: watchedEp + 1, to: lastNotified };
			if (group.length > 1) {
				common.push({ ...entry, people: group.map((g) => g.displayName) });
			} else {
				individual.get(group[0].id).push(entry);
			}
		}
	}

	return { individual, common };
}

function formatReport(people, { individual, common }) {
	const multiplePeople = people.length > 1;
	const lines = [];

	for (const p of people) {
		lines.push(multiplePeople ? `**Individual — ${p.displayName}**` : `**Pendientes de ${p.displayName}**`);
		const items = individual.get(p.id);
		if (items.length === 0) {
			lines.push('Sin pendientes individuales.');
		} else {
			for (const it of items) lines.push(`• ${it.title}: ${episodeRange(it.from, it.to)}`);
		}
		lines.push('');
	}

	if (multiplePeople) {
		lines.push('**En común**');
		if (common.length === 0) {
			lines.push('Nadie coincide todavía en el mismo capítulo pendiente.');
		} else {
			for (const it of common) lines.push(`• ${it.title} (${it.people.join(', ')}): ${episodeRange(it.from, it.to)}`);
		}
	}

	return lines.join('\n').trim();
}

async function showPending(interaction, seasonLabel, people, { isUpdate = false } = {}) {
	const report = buildPendingReport({ seasonLabel, guildId: interaction.guildId, people });
	let content = formatReport(people, report);
	// Límite de 2000 caracteres por mensaje de Discord.
	if (content.length > 1900) content = `${content.slice(0, 1900)}\n…(recortado)`;

	if (isUpdate) {
		await interaction.update({ content, components: [] });
	} else {
		await interaction.reply({ content, ephemeral: true });
	}
	autoCleanupReply(interaction);
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
			console.error('[pendientes] no pude refrescar la lista de miembros:', err.message);
		}
	}

	// Mismo criterio que /en-comun: solo ofrece gente con al menos un voto verde/naranja en la
	// temporada activa, cruzado contra la caché de miembros de este guild.
	const votes = getVotesForSeason(seasonLabel).filter((v) => v.voteType === 'verde' || v.voteType === 'naranja');
	const uniqueIds = [...new Set(votes.map((v) => v.discordId))].filter((id) => id !== interaction.user.id);
	const eligible = uniqueIds
		.map((id) => interaction.guild.members.cache.get(id))
		.filter(Boolean)
		.map((member) => ({ id: member.id, displayName: member.displayName }))
		.sort((a, b) => a.displayName.localeCompare(b.displayName));

	// Sin nadie más con quien comparar, directamente muestra los pendientes propios.
	if (eligible.length === 0) {
		await showPending(interaction, seasonLabel, [{ id: interaction.user.id, displayName: interaction.member.displayName }]);
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

	await showPending(interaction, seasonLabel, people, { isUpdate: true });
}

async function handleSoloButton(interaction) {
	const seasonLabel = getActiveSeason(interaction.guildId);
	if (!seasonLabel) {
		await interaction.update({ content: 'No hay una temporada activa en este servidor.', components: [] });
		autoCleanupReply(interaction);
		return;
	}

	await showPending(interaction, seasonLabel, [{ id: interaction.user.id, displayName: interaction.member.displayName }], { isUpdate: true });
}

module.exports = { data, execute, handleSelect, handleSoloButton };
