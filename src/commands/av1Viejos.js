const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const {
	listActiveSeasonLabels,
	getAnimeForSeason,
	getAv1ForumThread,
	getForumChannel,
	getLastNotifiedAv1Episode,
	setLastNotifiedAv1Episode,
} = require('../services/db');
const { getDownloadLinks } = require('../services/animeav1');

// Evita spamear si el usuario ejecuta el comando varias veces.
// Tomamos el último episodio que ya había sido procesado por el scheduler y publicamos desde ahí + 1.
function getEpisodeRangeToFetch({ from, currentMax }) {
	if (from < 1) return { start: 1, end: currentMax };
	return { start: from, end: currentMax };
}

// Busca el máximo episodio disponible para un anime consultando la página del primer episodio
// y caminando hacia adelante hasta que falle. Esto es costoso, pero el pedido es "desde 1 hasta el último".
async function findLastEpisodeNumber(slug, maxTries = 300) {
	// Estrategia: búsqueda incremental
	let ep = 1;
	let lastOk = 0;
	while (ep <= maxTries) {
		try {
			// Si existe, el parser va a encontrar links (o al menos pagina).
			await getDownloadLinks(slug, ep);
			lastOk = ep;
			ep += 1;
		} catch {
			break;
		}
	}
	return lastOk;
}

function formatEpisodeMessage(episode, dl) {
	const lines = [];
	lines.push(`Episodio **${episode}** — Descargas`);
	if (dl?.pageUrl) lines.push(`Fuente: ${dl.pageUrl}`);
	if (dl?.providers) {
		for (const [provider, urls] of dl.providers.entries()) {
			if (!urls || urls.length === 0) continue;
			lines.push(`\n**${provider}**`);
			for (const u of urls) lines.push(`- ${u}`);
		}
	}
	return lines.filter(Boolean).join('\n');
}

const ONE_PIECE_MATCH = /one\s*piece/i;

// (Deprecated) Renombrado a /recarga. Se deja para compatibilidad si quedara registrado.
const data = new SlashCommandBuilder()
	.setName('av1-viejos')
	.setDescription('Trae episodios antiguos desde animeav1 al foro (excepto One Piece)')

	.addStringOption((o) =>
		o.setName('season')
			.setDescription('Opcional: limita a una temporada específica (ej: Verano 2026). Si se omite, usa todas las temporadas activas del bot)')
			.setRequired(false),
	)
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function execute(interaction) {
	await interaction.deferReply({ ephemeral: true });

	const seasonFilter = interaction.options.getString('season');
	const seasons = seasonFilter
		? [seasonFilter]
		: listActiveSeasonLabels();

	const tracked = seasons.flatMap((seasonLabel) => getAnimeForSeason(seasonLabel));
	if (tracked.length === 0) {
		await interaction.editReply('No hay animes registrados para las temporadas elegidas. Primero corré /temporada-foro.');
		return;
	}

	let processed = 0;
	let skipped = 0;

	// Recorremos en serie para no pegarle de más a animeav1/Discord.
	for (const anime of tracked) {
		try {
			if (!anime?.title || ONE_PIECE_MATCH.test(anime.title)) {
				skipped += 1;
				continue;
			}

			const threadId = getAv1ForumThread({
				guildId: anime.guildId,
				seasonLabel: anime.seasonLabel,
				malId: anime.malId,
			});

			if (!threadId) {
				// El anime existe, pero el hilo no fue registrado (por ejemplo, no se corrió temporada-foro con esta versión).
				skipped += 1;
				continue;
			}

			const lastNotified = getLastNotifiedAv1Episode({ seasonLabel: anime.seasonLabel, malId: anime.malId });

			// Hallamos el último episodio.
			await interaction.editReply(`Buscando último episodio para **${anime.title}** en animeav1...`);
			const lastEpisode = await findLastEpisodeNumber(anime.slug ?? anime.av1Slug ?? anime.malId);
			// Nota: en db.js guardamos anime de Jikan, no slug de animeav1. Para evitar romper el flujo,
			// si no tenemos slug no podemos continuar. (Se necesita que animeav1 sea guardado en la memoria del bot).
			if (!lastEpisode || !Number.isFinite(lastEpisode)) throw new Error('No pude determinar el último episodio (faltan datos).');

			const startFrom = Math.max(1, lastNotified + 1);
			for (let ep = startFrom; ep <= lastEpisode; ep += 1) {
				const dl = await getDownloadLinks(anime.slug, ep);
				const msg = formatEpisodeMessage(ep, dl);
				const thread = await interaction.client.channels.fetch(threadId);
				await thread.send(msg);
				setLastNotifiedAv1Episode({ seasonLabel: anime.seasonLabel, malId: anime.malId, episode: ep });
				processed += 1;
			}
		} catch (err) {
			console.error('[av1-viejos] error:', err.message);
		}
	}

	await interaction.editReply(`Listo. Publicados ${processed} episodio(s). Saltados ${skipped}.`);
}

module.exports = { data, execute };

