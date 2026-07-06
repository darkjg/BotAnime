const { SlashCommandBuilder } = require('discord.js');
const { getAnimeForSeason, getActiveSeason, getVoteRole, setEpisodesWatched, getEpisodesWatched, getUserVotedAnime } = require('../services/db');
const { getAnime } = require('../seasonCache');

const data = new SlashCommandBuilder()
	.setName('capitulo')
	.setDescription('Actualiza el capítulo por el que vas de un anime de la temporada activa')
	.addStringOption((option) =>
		option.setName('anime').setDescription('Anime de la temporada activa').setRequired(true).setAutocomplete(true),
	)
	.addIntegerOption((option) =>
		option.setName('cantidad').setDescription('Capítulo por el que vas ahora').setRequired(true).setAutocomplete(true),
	)
	.addUserOption((option) => option.setName('usuario').setDescription('A quién actualizar (por defecto, vos)').setRequired(false));

async function autocompleteAnime(interaction, seasonLabel) {
	// Solo ofrece animes que la persona votó verde/naranja: no tiene sentido actualizar el capítulo de
	// algo que ni siquiera está siguiendo.
	const votedMalIds = new Set(getUserVotedAnime({ seasonLabel, discordId: interaction.user.id }));
	const focused = interaction.options.getFocused().toLowerCase();
	const choices = getAnimeForSeason(seasonLabel)
		.filter((anime) => votedMalIds.has(anime.malId))
		.filter((anime) => anime.title.toLowerCase().includes(focused))
		.slice(0, 25)
		.map((anime) => ({ name: anime.title.slice(0, 100), value: String(anime.malId) }));

	await interaction.respond(choices);
}

// Sugiere el capítulo actual (y un par de siguientes) para que la persona vea de dónde parte en vez
// de tener que acordarse/ir a mirar el hilo. Solo tiene sentido si ya eligió el anime.
async function autocompleteCantidad(interaction, seasonLabel) {
	const malIdRaw = interaction.options.getString('anime');
	const malId = malIdRaw ? Number(malIdRaw) : null;
	if (!malId) {
		await interaction.respond([]);
		return;
	}

	const targetUser = interaction.options.getUser('usuario') ?? interaction.user;
	const current = getEpisodesWatched({ seasonLabel, malId, discordId: targetUser.id });

	const choices = [
		{ name: `Actual: ${current}`, value: current },
		{ name: `${current + 1}`, value: current + 1 },
		{ name: `${current + 2}`, value: current + 2 },
	];
	await interaction.respond(choices);
}

async function autocomplete(interaction) {
	const seasonLabel = getActiveSeason(interaction.guildId);
	if (!seasonLabel) {
		await interaction.respond([]);
		return;
	}

	const focused = interaction.options.getFocused(true);
	if (focused.name === 'cantidad') {
		await autocompleteCantidad(interaction, seasonLabel);
	} else {
		await autocompleteAnime(interaction, seasonLabel);
	}
}

async function execute(interaction) {
	const voteRoleId = getVoteRole(interaction.guildId);
	if (voteRoleId && !interaction.member.roles.cache.has(voteRoleId)) {
		await interaction.reply({ content: 'No tienes el rol necesario para votar.', ephemeral: true });
		return;
	}

	const seasonLabel = getActiveSeason(interaction.guildId);
	if (!seasonLabel) {
		await interaction.reply({ content: 'No hay una temporada activa en este servidor.', ephemeral: true });
		return;
	}

	const malId = Number(interaction.options.getString('anime', true));
	const newCount = interaction.options.getInteger('cantidad', true);
	const targetUser = interaction.options.getUser('usuario') ?? interaction.user;

	const anime = getAnime(malId);
	if (!anime) {
		await interaction.reply({ content: 'No encontré ese anime (elígelo de la lista que sugiere el autocompletado).', ephemeral: true });
		return;
	}

	const targetMember =
		targetUser.id === interaction.user.id ? interaction.member : await interaction.guild.members.fetch(targetUser.id).catch(() => null);
	const displayName = targetMember?.displayName ?? targetUser.username;

	const episodesWatched = setEpisodesWatched({ seasonLabel, malId, discordId: targetUser.id, displayName, episodesWatched: newCount });

	console.log(`[capitulo] ${interaction.user.tag} puso a ${displayName} en el capítulo ${episodesWatched} de "${anime.title}" (${seasonLabel})`);

	await interaction.reply({
		content: `Listo: **${displayName}** ahora va por el capítulo **${episodesWatched}** de **${anime.title}**.`,
		ephemeral: true,
	});
}

module.exports = { data, execute, autocomplete };
