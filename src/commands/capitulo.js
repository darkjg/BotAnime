const { SlashCommandBuilder } = require('discord.js');
const {
	getAnimeForSeason,
	getActiveSeason,
	getVoteRole,
	setEpisodesWatched,
	getEpisodesWatched,
	getUserVotedAnime,
	getUserVote,
	isCaughtUpThisWeek,
	getVoteState,
	getWatchersWithProgress,
	getAv1ForumThread,
	getAnimeAcrossGuilds,
} = require('../services/db');
const { setVote } = require('../services/sheets');
const { getAnime } = require('../seasonCache');
const { buildAnimeEmbed, buildVoteRow } = require('../components');
const { autoCleanupReply } = require('../ephemeral');

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

	// getAnimeForSeason no filtra por guild: el mismo malId puede tener un registro por cada guild que
	// lo publicó (producción y el de pruebas comparten seasonLabel), y sin este filtro + dedup el mismo
	// anime aparecía dos veces en la lista de sugerencias.
	const vistos = new Set();
	const choices = getAnimeForSeason(seasonLabel)
		.filter((anime) => anime.guildId === interaction.guildId)
		.filter((anime) => votedMalIds.has(anime.malId))
		.filter((anime) => anime.title.toLowerCase().includes(focused))
		.filter((anime) => (vistos.has(anime.malId) ? false : (vistos.add(anime.malId), true)))
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
		autoCleanupReply(interaction);
		return;
	}

	const seasonLabel = getActiveSeason(interaction.guildId);
	if (!seasonLabel) {
		await interaction.reply({ content: 'No hay una temporada activa en este servidor.', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}

	const malId = Number(interaction.options.getString('anime', true));
	const newCount = interaction.options.getInteger('cantidad', true);
	const targetUser = interaction.options.getUser('usuario') ?? interaction.user;

	const anime = getAnime(malId);
	if (!anime) {
		await interaction.reply({ content: 'No encontré ese anime (elígelo de la lista que sugiere el autocompletado).', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}

	// Lo que sigue puede tardar más de los 3 segundos que da Discord sin deferir (fetch de miembro +
	// escritura en Sheets); sin este defer, cualquier lentitud hace fallar el reply final con "Unknown
	// interaction" aunque el capítulo sí se haya actualizado (mismo bug que ya vimos en el modal).
	await interaction.deferReply({ ephemeral: true });

	const targetMember =
		targetUser.id === interaction.user.id ? interaction.member : await interaction.guild.members.fetch(targetUser.id).catch(() => null);
	const displayName = targetMember?.displayName ?? targetUser.username;

	const episodesWatched = setEpisodesWatched({ seasonLabel, malId, discordId: targetUser.id, displayName, episodesWatched: newCount });

	// Si ya tiene un voto puesto, la celda de la sheet queda vieja hasta que se refresque con el
	// capítulo nuevo; si no votó (o votó rojo), no hay celda que actualizar. El voto/progreso es un solo
	// hecho real (no depende del guild desde el que se corrió /capitulo), así que se escribe en la
	// sheet de CADA guild que tenga este anime registrado, no solo la de este guild.
	const vote = getUserVote({ seasonLabel, malId, discordId: targetUser.id });
	if (vote && vote.voteType !== 'rojo') {
		const registros = getAnimeAcrossGuilds({ seasonLabel, malId });
		for (const registro of registros) {
			const caughtUpThisWeek = isCaughtUpThisWeek({ seasonLabel, malId, guildId: registro.guildId, episodesWatched });
			try {
				await setVote(seasonLabel, displayName, registro, vote.voteType, episodesWatched, caughtUpThisWeek);
			} catch (err) {
				console.error(`[capitulo] no pude refrescar la celda de "${displayName}" en la sheet (guild ${registro.guildId}):`, err.message);
			}
		}
	}

	// Refresca el embed del hilo del foro (quién lo ve y por qué capítulo va cada quien), ya que a
	// diferencia del botón "Actualizar capítulo" (que corre sobre ese mismo mensaje), /capitulo puede
	// invocarse desde cualquier canal.
	const threadId = getAv1ForumThread({ guildId: interaction.guildId, seasonLabel, malId });
	if (threadId) {
		try {
			const thread = await interaction.client.channels.fetch(threadId);
			const message = await thread.messages.fetch(threadId); // el post inicial comparte id con el hilo
			const voteState = getVoteState({ seasonLabel, malId });
			const progress = getWatchersWithProgress({ seasonLabel, malId });
			await message.edit({
				embeds: [buildAnimeEmbed(anime, { voteState, progress })],
				components: buildVoteRow(seasonLabel, malId, { voteState }),
			});
		} catch (err) {
			console.error(`[capitulo] no pude actualizar el embed del hilo de "${anime.title}":`, err.message);
		}
	}

	console.log(`[capitulo] ${interaction.user.tag} puso a ${displayName} en el capítulo ${episodesWatched} de "${anime.title}" (${seasonLabel})`);

	await interaction.editReply(`Listo: **${displayName}** ahora va por el capítulo **${episodesWatched}** de **${anime.title}**.`);
	autoCleanupReply(interaction);
}

module.exports = { data, execute, autocomplete };
