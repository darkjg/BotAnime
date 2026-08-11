const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const {
	getActiveSeason,
	getAnimeForSeason,
	getAllAnime,
	getAv1ForumThread,
	getLastNotifiedAv1Episode,
	setLastNotifiedAv1Episode,
	upsertAnime,
	getWatchers,
} = require('../services/db');
const { getDownloadLinks, findSlugByTitle } = require('../services/animeav1');
const { findEraiMagnet } = require('../services/nyaa');
const { autoCleanupReply } = require('../ephemeral');

function withTimeout(ms, promise, errMsg) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(errMsg ?? `timeout ${ms}ms`)), ms);
		promise
			.then((v) => {
				clearTimeout(t);
				resolve(v);
			})
			.catch((e) => {
				clearTimeout(t);
				reject(e);
			});
	});
}

// Busca el último episodio disponible para un anime consultando la página del episodio y avanzando
// hasta que falle. Arranca en `startEpisode` (no siempre en 1): para series con cientos/miles de
// episodios (ej. One Piece) animeav1 ya no tiene los primeros, así que probar desde el 1 siempre
// fallaría de entrada; arrancar desde el último que la gente ya tiene marcado evita eso.
async function findLastEpisodeNumber(slug, startEpisode = 1, maxTries = 150) {
	let ep = startEpisode;
	let lastOk = 0;
	const limit = startEpisode + maxTries - 1;
	while (ep <= limit) {
		try {
			await withTimeout(12_000, getDownloadLinks(slug, ep), `timeout getDownloadLinks ${ep}`);
			lastOk = ep;
			ep += 1;
		} catch {
			break;
		}
	}
	return lastOk;
}


// Un bot no puede escribir en el portapapeles del usuario (no existe esa API en Discord); lo más
// cercano es un bloque de código, que en el cliente de Discord muestra su propio ícono de copiar al
// pasar el mouse por arriba. Se usa para cada link/magnet individual en vez de como texto plano.
function codeBlock(text) {
	return `\`\`\`${text}\`\`\``;
}

function formatEpisodeMessage(episode, dl, erai) {
	const lines = [];
	lines.push(`Episodio **${episode}** — Descargas`);
	// <url> en vez de url a secas: evita que Discord genere el embed de vista previa para este link.
	if (dl?.pageUrl) lines.push(`Fuente: <${dl.pageUrl}>`);
	if (dl?.providers) {
		for (const [provider, urls] of dl.providers.entries()) {
			if (!urls || urls.length === 0) continue;
			lines.push(`\n**${provider}**`);
			for (const u of urls) lines.push(codeBlock(u));
		}
	}
	if (erai) {
		lines.push(`\n**Erai-raws (1080p)**`);
		lines.push(codeBlock(erai.magnet));
	}
	return lines.filter(Boolean).join('\n');
}

// Borra todos los mensajes de un hilo de foro EXCEPTO el primero (el post inicial con el embed y los
// botones de voto, que comparte id con el propio hilo). Se usa con "forzar" para que republicar no
// deje capítulos viejos duplicados arriba de los nuevos. bulkDelete no sirve para mensajes de más de
// 14 días, así que se borra uno por uno.
async function clearThreadReplies(thread) {
	let before;
	for (;;) {
		const page = await thread.messages.fetch({ limit: 100, before });
		if (page.size === 0) break;
		for (const message of page.values()) {
			if (message.id === thread.id) continue;
			await message.delete().catch((err) => console.error(`[recarga] no pude borrar un mensaje viejo de #${thread.name}:`, err.message));
		}
		before = page.last().id;
		if (page.size < 100) break;
	}
}

const data = new SlashCommandBuilder()
	.setName('recarga')
	.setDescription('Recarga capítulos viejos desde animeav1 al foro')
	.addBooleanOption((option) =>
		option
			.setName('forzar')
			.setDescription('Ignora el "último episodio avisado" y vuelve a publicar desde el episodio 1')
			.setRequired(false),
	);

async function execute(interaction) {
	await interaction.deferReply({ ephemeral: true });
	const forzar = interaction.options.getBoolean('forzar') ?? false;

	// Solo la temporada activa DE ESTE guild, y solo los animes cuyo registro pertenece a este guild:
	// getAnimeForSeason no filtra por guild, y como dos guilds pueden compartir la misma etiqueta de
	// temporada (ej. un guild de pruebas y el de producción), sin este filtro /recarga terminaría
	// posteando en los hilos de un guild distinto al que invocó el comando.
	const seasonLabel = getActiveSeason(interaction.guildId);
	let tracked = seasonLabel ? getAnimeForSeason(seasonLabel).filter((a) => a.guildId === interaction.guildId) : [];

	// Si la temporada no está marcada como "activa" para este guild, igual podés tener animes cargados
	// en la DB. En ese caso, hacemos fallback usando todos los animes del bot para este guild.
	if (tracked.length === 0) {
		tracked = getAllAnime().filter((a) => a.guildId === interaction.guildId);
		if (tracked.length === 0) {
			await interaction.editReply('No hay animes registrados para este servidor.');
			autoCleanupReply(interaction);
			return;
		}
	}


	let processed = 0;
	let skipped = 0;

	for (const anime of tracked) {
		try {
			if (!anime?.title) {
				skipped += 1;
				continue;
			}

			// Igual que el aviso semanal (scheduler.js): si nadie votó verde/naranja por este anime, no
			// tiene sentido bajarle los capítulos viejos. Sin este filtro se recorren los ~70+ animes de la
			// temporada entera, la mayoría sin nadie interesado.
			const watchers = getWatchers({ seasonLabel: anime.seasonLabel, malId: anime.malId });
			if (watchers.length === 0) {
				skipped += 1;
				continue;
			}

			// Necesitamos el slug de animeav1 para armar URLs de episodio. Los animes solo lo tienen
			// guardado si el scheduler ya los cruzó alguna vez contra "Recientemente Actualizado"; para el
			// resto lo buscamos ahora mismo por título en el buscador del sitio y lo guardamos para no
			// tener que repetir la búsqueda la próxima vez.
			let slug = anime.slug;
			if (!slug) {
				slug = await withTimeout(12_000, findSlugByTitle(anime.title), `timeout buscando slug de "${anime.title}"`).catch(() => null);
				if (slug) {
					upsertAnime({ malId: anime.malId, seasonLabel: anime.seasonLabel, guildId: anime.guildId, slug });
				}
			}
			if (!slug) {
				skipped += 1;
				continue;
			}

			const threadId = getAv1ForumThread({
				guildId: anime.guildId,
				seasonLabel: anime.seasonLabel,
				malId: anime.malId,
			});

			if (!threadId) {
				skipped += 1;
				continue;
			}

			const lastNotified = forzar ? 0 : getLastNotifiedAv1Episode({ seasonLabel: anime.seasonLabel, malId: anime.malId, guildId: anime.guildId });
			const startFrom = Math.max(1, lastNotified + 1);
			await interaction.editReply(`Procesando **${anime.title}**...`);

			const lastEpisode = await findLastEpisodeNumber(slug, startFrom);
			if (!lastEpisode || startFrom > lastEpisode) {
				// Sin episodios en animeav1 todavía, o ya estábamos al día con el último disponible.
				skipped += 1;
				continue;
			}

			const thread = await interaction.client.channels.fetch(threadId);
			if (forzar) await clearThreadReplies(thread);
			for (let ep = startFrom; ep <= lastEpisode; ep += 1) {
				// Otra corrida de /recarga (o el chequeo automático de cada 30min) puede haber reclamado
				// este mismo episodio mientras esperábamos; se re-chequea justo antes de reclamarlo.
				const alreadyClaimed = forzar
					? false
					: ep <= getLastNotifiedAv1Episode({ seasonLabel: anime.seasonLabel, malId: anime.malId, guildId: anime.guildId });
				if (alreadyClaimed) continue;

				let dl;
				try {
					dl = await withTimeout(12_000, getDownloadLinks(slug, ep), `timeout getDownloadLinks ${ep}`);
				} catch {
					// si un episodio puntual falla, seguimos con el resto para no bloquear
					continue;
				}

				// Reclama antes de mandar (no después): así una ejecución concurrente que llegue a este
				// mismo punto ve el reclamo y no vuelve a postear el mismo capítulo.
				setLastNotifiedAv1Episode({ seasonLabel: anime.seasonLabel, malId: anime.malId, guildId: anime.guildId, episode: ep });

				// El magnet es un extra: si nyaa.one falla o no tiene el release, el mensaje sale igual
				// solo con lo de animeav1.
				const erai = await findEraiMagnet(anime.title, ep).catch(() => null);
				const msg = formatEpisodeMessage(ep, dl, erai);
				await thread.send(msg);
				processed += 1;
			}

		} catch (err) {
			console.error('[recarga] error:', err.message);
		}
	}

	await interaction.editReply(`Listo. Publicados ${processed} episodio(s). Saltados ${skipped}.`);
	autoCleanupReply(interaction);
}

module.exports = { data, execute };

