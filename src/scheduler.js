const {
	getAnimeAiringOn,
	getWatchers,
	getNotificationChannel,
	wasNotifiedToday,
	markNotifiedToday,
	listActiveSeasonLabels,
	getAnimeForSeason,
	getLastNotifiedAv1Episode,
	setLastNotifiedAv1Episode,
	upsertAnime,
} = require('./services/db');
const { EmbedBuilder } = require('discord.js');
const { updateAnimeDay, repairSeasonTab } = require('./services/sheets');
const { getRecentlyUpdatedEpisodes, normalizeTitle, getCoverImage } = require('./services/animeav1');
const { buildEpisodeButtonRow } = require('./components');
const { rememberAnime } = require('./seasonCache');

const ES_WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const AV1_CHECK_INTERVAL_MS = 30 * 60 * 1000;

function todayKey() {
	return new Date().toISOString().slice(0, 10);
}

async function checkAndNotify(client) {
	const today = ES_WEEKDAYS[new Date().getDay()];
	const dateKey = todayKey();
	const airingToday = getAnimeAiringOn(today);

	console.log(`[scheduler] chequeo ${dateKey} (${today}): ${airingToday.length} anime(s) emiten hoy`);

	for (const entry of airingToday) {
		if (wasNotifiedToday({ seasonLabel: entry.seasonLabel, malId: entry.malId, dateKey })) {
			console.log(`[scheduler] "${entry.title}" ya se avisó hoy, salto`);
			continue;
		}

		const watchers = getWatchers({ seasonLabel: entry.seasonLabel, malId: entry.malId });
		markNotifiedToday({ seasonLabel: entry.seasonLabel, malId: entry.malId, dateKey });
		if (watchers.length === 0) {
			console.log(`[scheduler] "${entry.title}" no tiene votantes, no aviso`);
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
			await channel.send(`📢 Hoy sale nuevo capítulo de **${entry.title}**! ${mentions}`);
			console.log(`[scheduler] aviso enviado para "${entry.title}" a ${watchers.length} usuario(s) en #${channel.name}`);
		} catch (err) {
			console.error(`[scheduler] no pude avisar sobre "${entry.title}" en el canal configurado:`, err.message);
		}
	}
}

// Corre una vez al levantar el bot y luego cada hora; markNotifiedToday evita que se duplique el
// aviso si el check vuelve a correr el mismo día (reinicio del bot, etc.).
function startEpisodeNotifier(client) {
	console.log(`[scheduler] iniciado, va a chequear cada ${CHECK_INTERVAL_MS / 60_000} minutos`);
	checkAndNotify(client).catch((err) => console.error('[scheduler] falló el chequeo de avisos de episodios:', err));
	setInterval(() => {
		checkAndNotify(client).catch((err) => console.error('[scheduler] falló el chequeo de avisos de episodios:', err));
	}, CHECK_INTERVAL_MS);
}

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
			const lastNotified = getLastNotifiedAv1Episode({ seasonLabel: entry.seasonLabel, malId: entry.malId });
			if (av1Entry.episode <= lastNotified) continue;
			setLastNotifiedAv1Episode({ seasonLabel: entry.seasonLabel, malId: entry.malId, episode: av1Entry.episode });

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
			} catch (err) {
				console.error(`[scheduler] no pude avisar sobre "${entry.title}" (animeav1) en el canal configurado:`, err.message);
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

module.exports = { startEpisodeNotifier, startAv1EpisodeNotifier };
