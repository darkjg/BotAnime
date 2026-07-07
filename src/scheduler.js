const {
	getWatchers,
	getNotificationChannel,
	listActiveSeasonLabels,
	getAnimeForSeason,
	getLastNotifiedAv1Episode,
	setLastNotifiedAv1Episode,
	upsertAnime,
	getForumChannel,
	getAv1ForumThread,
	getNotifyWindow,
} = require('./services/db');

const { EmbedBuilder } = require('discord.js');
const { updateAnimeDay, repairSeasonTab } = require('./services/sheets');
const { getRecentlyUpdatedEpisodes, normalizeTitle, getCoverImage, getDownloadLinks } = require('./services/animeav1');

const { buildEpisodeButtonRow } = require('./components');
const { rememberAnime } = require('./seasonCache');

const ES_WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const AV1_CHECK_INTERVAL_MS = 30 * 60 * 1000;

// Cruza el bloque "Recientemente Actualizado" de la home de animeav1.com contra los animes de las
// temporadas activas: si salió un episodio nuevo de algo que alguien está votando/siguiendo, avisa
// en el canal configurado. El cruce es por título normalizado porque animeav1 no expone el malId en
// ningún lado; si su título no coincide con el de MAL (traducciones, puntuación distinta, etc.) el
// aviso simplemente no sale para ese anime.
async function checkAndNotifyAv1(client) {
	let updated;
	try {
		updated = await getRecentlyUpdatedEpisodes();
	} catch (err) {
		console.error('[scheduler] no pude leer animeav1.com:', err.message);
		return;
	}
	if (updated.length === 0) return;

	const tracked = listActiveSeasonLabels().flatMap((seasonLabel) => getAnimeForSeason(seasonLabel));
	if (tracked.length === 0) return;

	const byTitle = new Map();
	for (const entry of tracked) {
		const key = normalizeTitle(entry.title);
		if (!byTitle.has(key)) byTitle.set(key, []);
		byTitle.get(key).push(entry);
	}

	// Temporadas cuya sheet quedó con un día de emisión corregido en esta pasada: se reparan una sola
	// vez al final (no por cada anime) para no repetir el reordenado de columnas varias veces seguidas.
	const seasonsToRepair = new Set();

	for (const av1Entry of updated) {
		const matches = byTitle.get(normalizeTitle(av1Entry.title));
		if (!matches) continue;

		for (const entry of matches) {
			const lastNotified = getLastNotifiedAv1Episode({ seasonLabel: entry.seasonLabel, malId: entry.malId, guildId: entry.guildId });
			if (av1Entry.episode <= lastNotified) continue;

			// Ventana horaria configurable (por defecto 17-23h): si el episodio se detecta fuera de esas
			// horas, se reintenta en el próximo chequeo (30min) dentro de la ventana, sin reclamar el
			// episodio todavía (si se reclamara ahora, no se volvería a intentar nunca).
			const { startHour, endHour } = getNotifyWindow(entry.guildId);
			const hour = new Date().getHours();
			if (hour < startHour || hour >= endHour) {
				console.log(`[scheduler] "${entry.title}": episodio nuevo fuera de la ventana de avisos (${startHour}-${endHour}h), reintento más tarde`);
				continue;
			}

			setLastNotifiedAv1Episode({ seasonLabel: entry.seasonLabel, malId: entry.malId, guildId: entry.guildId, episode: av1Entry.episode });

			// El día guardado viene de MAL (Jikan), que puede no coincidir con el día real en que animeav1
			// publica el episodio. Un episodio nuevo es la evidencia más fresca de cuál es el día real, así
			// que lo usamos para corregir la base local y, si el anime ya tiene columna, la sheet.
			const today = ES_WEEKDAYS[new Date().getDay()];
			if (entry.broadcastDay !== today) {
				console.log(`[scheduler] "${entry.title}": día guardado (${entry.broadcastDay ?? 'sin día'}) no coincide con el día real (${today}), corrigiendo`);
				upsertAnime({ ...entry, broadcastDay: today });
				entry.broadcastDay = today;
				try {
					const changedInSheet = await updateAnimeDay(entry.seasonLabel, entry, today);
					if (changedInSheet) seasonsToRepair.add(entry.seasonLabel);
				} catch (err) {
					console.error(`[scheduler] no pude corregir el día de emisión de "${entry.title}" en la sheet:`, err.message);
				}
			}

			const watchers = getWatchers({ seasonLabel: entry.seasonLabel, malId: entry.malId });
			if (watchers.length === 0) {
				console.log(`[scheduler] "${entry.title}" episodio ${av1Entry.episode} disponible en animeav1, pero no tiene votantes`);
				continue;
			}

			const channelId = getNotificationChannel(entry.guildId);
			if (!channelId) {
				console.log(`[scheduler] "${entry.title}": guild ${entry.guildId} no tiene canal de avisos configurado (/avisos-canal)`);
				continue;
			}

			try {
				const channel = await client.channels.fetch(channelId);
				const mentions = watchers.map((id) => `<@${id}>`).join(' ');

				// Sin la portada el aviso igual sirve, así que un fallo de red acá no debe frenarlo.
				const cover = await getCoverImage(av1Entry.slug).catch(() => null);
				const embed = new EmbedBuilder()
					.setTitle(entry.title)
					.setURL(av1Entry.url)
					.setDescription(`Episodio **${av1Entry.episode}** disponible en animeav1`)
					.setColor(0x2b6cb0);
				if (cover) embed.setImage(cover);

				rememberAnime(entry);
				await channel.send({ content: `📢 ${mentions}`, embeds: [embed], components: [buildEpisodeButtonRow(entry.seasonLabel, entry.malId)] });
				console.log(`[scheduler] aviso de animeav1 enviado para "${entry.title}" ep. ${av1Entry.episode} a ${watchers.length} usuario(s) en #${channel.name}`);

				// Publicación en el hilo del anime dentro del foro de la temporada.
				// Reglas:
				// - solo lo publicamos cuando detectamos un episodio nuevo (ya está dedupeado con av1NotifiedEpisodes)
				// - si no existe threadId registrado, no rompemos el aviso semanal
				const forumThreadId = getAv1ForumThread({ guildId: entry.guildId, seasonLabel: entry.seasonLabel, malId: entry.malId });
				if (forumThreadId) {
					const thread = await client.channels.fetch(forumThreadId).catch(() => null);
					if (thread && thread.isThread && thread.isThread()) {
						const dl = await getDownloadLinks(av1Entry.slug, av1Entry.episode).catch(() => null);
						if (dl?.providers && dl.providers.size > 0) {
							const lines = [];
							lines.push(`Episodio **${av1Entry.episode}** — Descargas`);
							lines.push(dl.pageUrl ? `Fuente: ${dl.pageUrl}` : '');
							for (const [provider, urls] of dl.providers.entries()) {
								if (!urls || urls.length === 0) continue;
								lines.push(`\n**${provider}**`);
								for (const u of urls) lines.push(`- ${u}`);
							}

							const msg = lines.filter(Boolean).join('\n');
							await thread.send(msg);
							console.log(`[scheduler] publicado en foro para "${entry.title}" ep. ${av1Entry.episode}`);
						}
					}
				}
			} catch (err) {
				console.error(`[scheduler] no pude avisar/publicar sobre "${entry.title}" (animeav1):`, err.message);
			}

		}
	}

	for (const seasonLabel of seasonsToRepair) {
		try {
			await repairSeasonTab(seasonLabel);
			console.log(`[scheduler] "${seasonLabel}": columnas reordenadas en la sheet tras corregir día(s) de emisión`);
		} catch (err) {
			console.error(`[scheduler] no pude reordenar "${seasonLabel}" tras corregir día(s) de emisión:`, err.message);
		}
	}
}

// Corre una vez al levantar el bot y luego cada 30 minutos.
function startAv1EpisodeNotifier(client) {
	console.log(`[scheduler] chequeo de animeav1 iniciado, va a chequear cada ${AV1_CHECK_INTERVAL_MS / 60_000} minutos`);
	checkAndNotifyAv1(client).catch((err) => console.error('[scheduler] falló el chequeo de animeav1:', err));
	setInterval(() => {
		checkAndNotifyAv1(client).catch((err) => console.error('[scheduler] falló el chequeo de animeav1:', err));
	}, AV1_CHECK_INTERVAL_MS);
}

module.exports = { startAv1EpisodeNotifier };
