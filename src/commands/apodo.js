const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const {
	getActiveSeason,
	getAnimeForSeason,
	getAnimeAcrossGuilds,
	setAnimeNickname,
	getAnimeNickname,
	getDisplayTitle,
	getAv1ForumThread,
	getVoteState,
	getWatchersWithProgress,
} = require('../services/db');
const { updateAnimeTitle } = require('../services/sheets');
const { buildAnimeEmbed, buildVoteRow } = require('../components');
const { autoCleanupReply } = require('../ephemeral');
const { reabrirSiArchivado } = require('../threadUtil');

const data = new SlashCommandBuilder()
	.setName('apodo')
	.setDescription('Ponerle un apodo a un anime (se usa en vez del título real en todos lados)')
	.addStringOption((option) =>
		option.setName('anime').setDescription('Anime de la temporada activa').setRequired(true).setAutocomplete(true),
	)
	.addStringOption((option) =>
		option.setName('apodo').setDescription('Apodo a usar (dejar vacío para quitarlo)').setRequired(false),
	)
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

// A diferencia de /capitulo, esto lista TODOS los animes de la temporada activa (no solo los que
// votó quien tipea) — poner un apodo es una acción de administración, no depende de estar siguiéndolo.
async function autocomplete(interaction) {
	const seasonLabel = getActiveSeason(interaction.guildId);
	if (!seasonLabel) {
		await interaction.respond([]);
		return;
	}

	const focused = interaction.options.getFocused().toLowerCase();
	const vistos = new Set();
	const choices = getAnimeForSeason(seasonLabel)
		.filter((anime) => anime.guildId === interaction.guildId)
		.filter((anime) => anime.title.toLowerCase().includes(focused))
		.filter((anime) => (vistos.has(anime.malId) ? false : (vistos.add(anime.malId), true)))
		.slice(0, 25)
		.map((anime) => ({ name: anime.title.slice(0, 100), value: String(anime.malId) }));

	await interaction.respond(choices);
}

// Refresca el nombre del hilo y el embed del post inicial en la sheet+foro de CADA guild que tenga
// este anime (mismo motivo que setVote/relocateAnimeColumn en otros comandos: es un solo hecho real,
// no "uno por guild") — así el apodo se ve al instante, sin esperar a que alguien vote o actualice su
// capítulo para que el embed se refresque solo.
async function refreshEverywhere(interaction, seasonLabel, malId, displayTitle) {
	for (const registro of getAnimeAcrossGuilds({ seasonLabel, malId })) {
		try {
			await updateAnimeTitle(seasonLabel, registro, displayTitle);
		} catch (err) {
			console.error(`[apodo] no pude actualizar el título en la sheet (guild ${registro.guildId}):`, err.message);
		}

		const threadId = getAv1ForumThread({ guildId: registro.guildId, seasonLabel, malId });
		if (!threadId) continue;
		try {
			const thread = await interaction.client.channels.fetch(threadId);
			await reabrirSiArchivado(thread);
			await thread.setName(displayTitle.slice(0, 100));

			const message = await thread.messages.fetch(threadId); // el post inicial comparte id con el hilo
			const voteState = getVoteState({ seasonLabel, malId });
			const progress = getWatchersWithProgress({ seasonLabel, malId });
			await message.edit({
				embeds: [buildAnimeEmbed(registro, { voteState, progress })],
				components: buildVoteRow(seasonLabel, malId, { voteState }),
			});
		} catch (err) {
			console.error(`[apodo] no pude refrescar el hilo del foro (guild ${registro.guildId}):`, err.message);
		}
	}
}

async function execute(interaction) {
	await interaction.deferReply({ ephemeral: true });

	const seasonLabel = getActiveSeason(interaction.guildId);
	if (!seasonLabel) {
		await interaction.editReply('No hay una temporada activa en este servidor.');
		autoCleanupReply(interaction);
		return;
	}

	const malId = Number(interaction.options.getString('anime', true));
	const anime = getAnimeForSeason(seasonLabel).find((a) => a.guildId === interaction.guildId && a.malId === malId);
	if (!anime) {
		await interaction.editReply('No encuentro ese anime en la temporada activa.');
		autoCleanupReply(interaction);
		return;
	}

	const nuevoApodo = interaction.options.getString('apodo');
	const anterior = getAnimeNickname(malId);
	const resultado = setAnimeNickname({ malId, nickname: nuevoApodo, setBy: interaction.user.id });

	console.log(`[apodo] ${interaction.user.tag} ${resultado ? `puso "${resultado}"` : 'quitó el apodo'} para "${anime.title}" (${malId})`);

	const displayTitle = getDisplayTitle(anime);
	await refreshEverywhere(interaction, seasonLabel, malId, displayTitle);

	const mensaje = resultado
		? `Listo, **${anime.title}** va a aparecer como **${resultado}** de ahora en más.`
		: anterior
			? `Listo, le quité el apodo a **${anime.title}** — vuelve a mostrarse con su título real.`
			: `**${anime.title}** no tenía apodo puesto.`;

	await interaction.editReply(mensaje);
	autoCleanupReply(interaction);
}

module.exports = { data, execute, autocomplete };
