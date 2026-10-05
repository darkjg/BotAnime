const {
	getWatchers,
	getNotificationChannel,
	getAllAnime,
	getActiveSeason,
	getAnimeForSeason,
	getLastNotifiedAv1Episode,
	setLastNotifiedAv1Episode,
	upsertAnime,
	getForumChannel,
	getAv1ForumThread,
	getAv1ForumThreadAnySeason,
	getNotifyWindow,
	recordEpisodeLinkMessage,
	updateEpisodeLinkMessageProviders,
	deleteEpisodeLinkMessage,
	collectDueEpisodeLinkChecks,
	getWatchersWithProgress,
	getDisplayTitle,
	savePendingNotice,
	hasPendingNotice,
	listPendingNotices,
	deletePendingNotice,
} = require('./services/db');

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { updateAnimeDay, repairSeasonTab } = require('./services/sheets');
const { conServidor } = require('./services/sheetTarget');
const { getRecentlyUpdatedEpisodes, normalizeTitle, getCoverImage, getDownloadLinks } = require('./services/animeav1');
const { findEraiMagnet } = require('./services/nyaa');

const { buildEpisodeButtonRow, formatProgressLines } = require('./components');
const { rememberAnime } = require('./seasonCache');
const { reabrirSiArchivado } = require('./threadUtil');
const { isBackupMode, ensureWarpOnStartup } = require('./services/av1Net');
const { onAv1FetchSuccess, onAv1FetchFailure } = require('./av1Backup');

// Un bot no puede escribir en el portapapeles del usuario (no existe esa API en Discord); lo más
// cercano es un bloque de código, que en el cliente de Discord muestra su propio ícono de copiar al
// pasar el mouse por arriba. Se usa para cada link/magnet individual en vez de como texto plano.
function codeBlock(text) {
	return `\`\`\`${text}\`\`\``;
}

const ES_WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const AV1_CHECK_INTERVAL_MS = 30 * 60 * 1000;
// Un capítulo recién publicado suele tener solo 1Fichier/MP4Upload; Mega y el torrent (Erai-raws)
// suelen tardar hasta unos días más en subirse. Pasada esta ventana se deja de revisar ese capítulo.
const PROVIDER_RECHECK_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;

// Cruza el bloque "Recientemente Actualizado" de la home de animeav1.com contra los animes de las
// temporadas activas: si salió un episodio nuevo de algo que alguien está votando/siguiendo, avisa
// en el canal configurado. El cruce es por título normalizado porque animeav1 no expone el malId en
// ningún lado; si su título no coincide con el de MAL (traducciones, puntuación distinta, etc.) el
// aviso simplemente no sale para ese anime.

// Todos los animes que hay que vigilar para avisos: antes esto solo miraba la temporada activa de cada
// guild (listActiveSeasonLabels), así que un anime que seguía en emisión en una temporada vieja pero no
// se marcó/logró carryover (ver addCarryoverAnime en temporadaShared.js) quedaba invisible para los
// avisos, igual que pasaba con /pendientes (mismo bug, mismo fix: revisar TODAS las temporadas que tuvo
// cada guild). seenMalIds evita avisar dos veces el mismo capítulo de un anime que sí está en más de una
// temporada (carryover normal): se procesa una sola vez, con los datos de la temporada activa si están
// disponibles (orden activa-primero), y si no con los de la temporada más vieja donde aparezca.
function getTrackedAnimeAllSeasons() {
	const guildIds = new Set(getAllAnime().map((a) => a.guildId));
	const tracked = [];
	for (const guildId of guildIds) {
		const activeSeasonLabel = getActiveSeason(guildId);
		const seasonLabels = [...new Set(getAllAnime().filter((a) => a.guildId === guildId).map((a) => a.seasonLabel))].sort(
			(a, b) => (a === activeSeasonLabel ? -1 : b === activeSeasonLabel ? 1 : 0),
		);
		const seenMalIds = new Set();
		for (const seasonLabel of seasonLabels) {
			for (const anime of getAnimeForSeason(seasonLabel).filter((a) => a.guildId === guildId)) {
				if (seenMalIds.has(anime.malId)) continue;
				seenMalIds.add(anime.malId);
				tracked.push(anime);
			}
		}
	}
	return tracked;
}

// Ventana horaria configurable (por defecto 17-23h) en la que se mandan los avisos.
function isInsideNotifyWindow(guildId) {
	const { startHour, endHour } = getNotifyWindow(guildId);
	const hour = new Date().getHours();
	return { inside: hour >= startHour && hour < endHour, startHour, endHour };
}

// Todo lo que hace falta de animeav1 para armar un aviso (links de descarga, magnet, portada) en un
// objeto serializable: el modo respaldo lo guarda tal cual y lo manda después, dentro de la ventana
// horaria, sin volver a consultar el sitio (que a esa hora puede estar bloqueado).
async function buildNotice(entry, av1Entry) {
	const dl = await getDownloadLinks(av1Entry.slug, av1Entry.episode).catch((err) => {
		console.error(`[scheduler] "${entry.title}" ep. ${av1Entry.episode}: falló getDownloadLinks:`, err.message);
		return null;
	});
	// El magnet es un extra: si nyaa.one falla o no tiene el release, el aviso sale igual solo con lo de animeav1.
	const erai = dl && dl.providers.size > 0 ? await findEraiMagnet(entry.title, av1Entry.episode).catch(() => null) : null;
	// Sin la portada el aviso igual sirve, así que un fallo de red acá no debe frenarlo.
	const cover = await getCoverImage(av1Entry.slug).catch(() => null);
	return {
		title: av1Entry.title,
		slug: av1Entry.slug,
		url: av1Entry.url,
		episode: av1Entry.episode,
		detectedAt: Date.now(),
		dl: dl ? { pageUrl: dl.pageUrl, providers: [...dl.providers.entries()] } : null,
		erai: erai ? { magnet: erai.magnet } : null,
		cover,
	};
}

// El mismo episodio de un mismo anime puede estar en varios servidores: se arma una sola vez por pasada.
function getNotice(entry, av1Entry, noticeCache) {
	const key = `${av1Entry.slug}:${av1Entry.episode}`;
	if (!noticeCache.has(key)) noticeCache.set(key, buildNotice(entry, av1Entry));
	return noticeCache.get(key);
}

// Modo respaldo, fuera de la ventana de avisos: en vez de esperar y depender de que animeav1 responda
// cuando se abra la ventana, se arma y se guarda el aviso ahora.
async function storePendingNotice(entry, av1Entry, noticeCache) {
	const key = { guildId: entry.guildId, seasonLabel: entry.seasonLabel, malId: entry.malId, episode: av1Entry.episode };
	if (hasPendingNotice(key)) return;
	if (getWatchers({ seasonLabel: entry.seasonLabel, malId: entry.malId }).length === 0 || !getNotificationChannel(entry.guildId)) return;

	const notice = await getNotice(entry, av1Entry, noticeCache);
	// Si falló la lectura de los links no se guarda nada: se reintenta en el próximo chequeo.
	if (!notice.dl) return;
	savePendingNotice({ ...key, payload: notice });
	console.log(`[scheduler] "${entry.title}" ep. ${av1Entry.episode}: aviso guardado para mandarlo en la ventana de avisos (modo respaldo)`);
}

// Publica el aviso de un episodio: mensaje de descargas en el hilo del foro (si existe) y el aviso
// con portada en el canal de avisos. Solo usa Discord y la base: no toca animeav1.
async function deliverNotice(client, entry, av1Entry, notice, { watchers, channelId }) {
	try {
		const channel = await client.channels.fetch(channelId);
		const mentions = watchers.map((id) => `<@${id}>`).join(' ');

		// Publicación en el hilo del anime dentro del foro de la temporada. Se hace ANTES del aviso
		// del canal general para poder linkear, desde ahí, directo al mensaje del capítulo en el
		// hilo (no solo al hilo en general).
		// Reglas:
		// - solo lo publicamos cuando detectamos un episodio nuevo (ya está dedupeado con av1NotifiedEpisodes)
		// - si no existe threadId registrado, no rompemos el aviso semanal
		let threadMessageUrl = null;
		// Si el carryover a esta temporada no llegó a crear hilo acá (ver getAv1ForumThreadAnySeason en
		// db.js), cae al hilo real de otra temporada en vez de perderse el mensaje de descargas entero.
		const forumThreadId =
			getAv1ForumThread({ guildId: entry.guildId, seasonLabel: entry.seasonLabel, malId: entry.malId }) ??
			getAv1ForumThreadAnySeason({ guildId: entry.guildId, malId: entry.malId });
		if (forumThreadId) {
			const thread = await client.channels.fetch(forumThreadId).catch(() => null);
			if (thread && thread.isThread && thread.isThread()) {
				const providers = new Map(notice.dl?.providers ?? []);
				// Antes esto se salteaba en silencio: un cambio de formato en animeav1 (bug real
				// detectado con "Katainaka no Ossan, Kensei ni Naru II" ep. 9-10, ver animeav1.js) dejaba
				// de publicarse el mensaje de descargas sin ningún rastro en los logs durante semanas.
				if (providers.size === 0) {
					console.error(`[scheduler] "${entry.title}" ep. ${av1Entry.episode}: no encontré ningún proveedor de descarga (¿cambió el formato de animeav1?)`);
				}
				if (providers.size > 0) {
					const lines = [];
					lines.push(`Episodio **${av1Entry.episode}** — Descargas`);
					// <url> en vez de url a secas: evita que Discord genere el embed de vista previa para
					// este link. Antes, ese embed se intercalaba entre el texto y el botón/Progreso de
					// abajo (los embeds automáticos siempre se renderizan después de todo el texto, pero
					// antes de los componentes), quedando "Progreso" separado del botón por un cartel
					// grande sin relación.
					lines.push(notice.dl.pageUrl ? `Fuente: <${notice.dl.pageUrl}>` : '');
					for (const [provider, urls] of providers.entries()) {
						if (!urls || urls.length === 0) continue;
						lines.push(`\n**${provider}**`);
						for (const u of urls) lines.push(codeBlock(u));
					}

					if (notice.erai) {
						lines.push(`\n**Erai-raws (1080p)**`);
						lines.push(codeBlock(notice.erai.magnet));
					}

					// Quién lo está viendo y por qué capítulo va, justo arriba del botón para actualizar
					// el propio: así no hay que ir a buscar el post inicial del hilo para saber si hay
					// que ponerse al día.
					const progressLines = formatProgressLines(
						getWatchersWithProgress({ seasonLabel: entry.seasonLabel, malId: entry.malId }),
					);
					if (progressLines) {
						lines.push(`\n📺 Progreso`);
						lines.push(progressLines);
					}

					const msg = lines.filter(Boolean).join('\n');
					await reabrirSiArchivado(thread);
					const threadMessage = await thread.send({
						content: msg,
						components: [buildEpisodeButtonRow(entry.seasonLabel, entry.malId)],
					});
					threadMessageUrl = `https://discord.com/channels/${entry.guildId}/${forumThreadId}/${threadMessage.id}`;
					console.log(`[scheduler] publicado en foro para "${entry.title}" ep. ${av1Entry.episode}`);

					recordEpisodeLinkMessage({
						guildId: entry.guildId,
						seasonLabel: entry.seasonLabel,
						malId: entry.malId,
						episode: av1Entry.episode,
						title: entry.title,
						slug: av1Entry.slug,
						threadId: forumThreadId,
						messageId: threadMessage.id,
						providers: [...providers.keys()],
						hasErai: Boolean(notice.erai),
					});
				}
			}
		}

		const embed = new EmbedBuilder()
			.setTitle(getDisplayTitle(entry))
			.setURL(av1Entry.url)
			.setDescription(`Episodio **${av1Entry.episode}** disponible en animeav1`)
			.setColor(0x2b6cb0);
		if (notice.cover) embed.setImage(notice.cover);

		const components = [buildEpisodeButtonRow(entry.seasonLabel, entry.malId)];
		if (threadMessageUrl) {
			components.push(
				new ActionRowBuilder().addComponents(
					new ButtonBuilder().setLabel('Ir al capítulo en el foro').setStyle(ButtonStyle.Link).setURL(threadMessageUrl),
				),
			);
		}

		rememberAnime(entry);
		await channel.send({ content: `📢 ${mentions}`, embeds: [embed], components });
		console.log(`[scheduler] aviso de animeav1 enviado para "${entry.title}" ep. ${av1Entry.episode} a ${watchers.length} usuario(s) en #${channel.name}`);
	} catch (err) {
		console.error(`[scheduler] no pude avisar/publicar sobre "${entry.title}" (animeav1):`, err.message);
	}
}

// Un episodio de un anime de la temporada. notice viene solo cuando sale de lo guardado por el modo
// respaldo; si no, el aviso se arma leyendo animeav1 en este momento.
async function processEpisode(client, entry, av1Entry, { notice = null, seasonsToRepair, noticeCache }) {
	const lastNotified = getLastNotifiedAv1Episode({ seasonLabel: entry.seasonLabel, malId: entry.malId, guildId: entry.guildId });
	if (av1Entry.episode <= lastNotified) return;

	// Si el episodio se detecta fuera de la ventana horaria, se reintenta en el próximo chequeo (30min)
	// dentro de la ventana, sin reclamar el episodio todavía (si se reclamara ahora, no se volvería a
	// intentar nunca). Con el modo respaldo activo, además se guarda armado para mandarlo al abrirse la ventana.
	const { inside, startHour, endHour } = isInsideNotifyWindow(entry.guildId);
	if (!inside) {
		if (isBackupMode() && !notice) {
			await storePendingNotice(entry, av1Entry, noticeCache);
		} else {
			console.log(`[scheduler] "${entry.title}": episodio nuevo fuera de la ventana de avisos (${startHour}-${endHour}h), reintento más tarde`);
		}
		return;
	}

	setLastNotifiedAv1Episode({ seasonLabel: entry.seasonLabel, malId: entry.malId, guildId: entry.guildId, episode: av1Entry.episode });

	// El día guardado viene de MAL (Jikan), que puede no coincidir con el día real en que animeav1
	// publica el episodio. Un episodio nuevo es la evidencia más fresca de cuál es el día real, así
	// que lo usamos para corregir la base local y, si el anime ya tiene columna, la sheet. Un aviso
	// guardado por el modo respaldo cuenta con el día en que se detectó, no con el de cuando se manda.
	const today = ES_WEEKDAYS[new Date(notice?.detectedAt ?? Date.now()).getDay()];
	if (entry.broadcastDay !== today) {
		console.log(`[scheduler] "${entry.title}": día guardado (${entry.broadcastDay ?? 'sin día'}) no coincide con el día real (${today}), corrigiendo`);
		upsertAnime({ ...entry, broadcastDay: today });
		entry.broadcastDay = today;
		try {
			// Cada servidor tiene su hoja: se corrige en la del servidor de este anime, y se apunta por servidor
			// qué temporada hay que reparar después.
			const changedInSheet = await conServidor(entry.guildId, () => updateAnimeDay(entry.seasonLabel, entry, today));
			if (changedInSheet) seasonsToRepair.add(`${entry.guildId}|${entry.seasonLabel}`);
		} catch (err) {
			console.error(`[scheduler] no pude corregir el día de emisión de "${entry.title}" en la sheet:`, err.message);
		}
	}

	const watchers = getWatchers({ seasonLabel: entry.seasonLabel, malId: entry.malId });
	if (watchers.length === 0) {
		console.log(`[scheduler] "${entry.title}" episodio ${av1Entry.episode} disponible en animeav1, pero no tiene votantes`);
		return;
	}

	const channelId = getNotificationChannel(entry.guildId);
	if (!channelId) {
		console.log(`[scheduler] "${entry.title}": guild ${entry.guildId} no tiene canal de avisos configurado (/avisos-canal)`);
		return;
	}

	const finalNotice = notice ?? (await getNotice(entry, av1Entry, noticeCache));
	await deliverNotice(client, entry, av1Entry, finalNotice, { watchers, channelId });
}

// Manda los avisos que el modo respaldo dejó guardados, en cuanto se abre la ventana de avisos de su
// servidor. No necesita animeav1: por eso corre antes de intentar leerlo.
async function deliverPendingNotices(client, seasonsToRepair) {
	const rows = listPendingNotices();
	if (rows.length === 0) return;

	for (const row of rows) {
		if (!isInsideNotifyWindow(row.guildId).inside) continue;

		const key = { guildId: row.guildId, seasonLabel: row.seasonLabel, malId: row.malId, episode: row.episode };
		// Match exacto por la temporada guardada en el aviso pendiente (no el resultado deduplicado de
		// getTrackedAnimeAllSeasons, que puede haber preferido otra temporada para este mismo malId).
		const entry = getAnimeForSeason(row.seasonLabel).find(
			(e) => e.guildId === row.guildId && Number(e.malId) === Number(row.malId),
		);
		if (entry) {
			const av1Entry = { title: row.payload.title, slug: row.payload.slug, url: row.payload.url, episode: row.episode };
			try {
				await processEpisode(client, entry, av1Entry, { notice: row.payload, seasonsToRepair, noticeCache: new Map() });
			} catch (err) {
				console.error(`[scheduler] no pude mandar el aviso guardado de "${entry.title}" ep. ${row.episode}:`, err.message);
			}
			// Si falló antes de reclamar el episodio, se deja guardado para reintentar en el próximo chequeo.
			const claimed = getLastNotifiedAv1Episode({ seasonLabel: entry.seasonLabel, malId: entry.malId, guildId: entry.guildId }) >= row.episode;
			if (!claimed) continue;
		}
		deletePendingNotice(key);
	}
}

async function checkRecentEpisodes(client, seasonsToRepair) {
	let updated;
	try {
		updated = await getRecentlyUpdatedEpisodes();
		onAv1FetchSuccess();
	} catch (err) {
		console.error('[scheduler] no pude leer animeav1.com:', err.message);
		await onAv1FetchFailure(client, { checkIntervalMs: AV1_CHECK_INTERVAL_MS }).catch((e) => console.error('[scheduler] falló el aviso de modo respaldo:', e.message));
		return;
	}
	if (updated.length === 0) return;

	const tracked = getTrackedAnimeAllSeasons();
	if (tracked.length === 0) return;

	const byTitle = new Map();
	for (const entry of tracked) {
		const key = normalizeTitle(entry.title);
		if (!byTitle.has(key)) byTitle.set(key, []);
		byTitle.get(key).push(entry);
	}

	const noticeCache = new Map();
	for (const av1Entry of updated) {
		const matches = byTitle.get(normalizeTitle(av1Entry.title));
		if (!matches) continue;

		for (const entry of matches) {
			await processEpisode(client, entry, av1Entry, { seasonsToRepair, noticeCache });
		}
	}
}

async function checkAndNotifyAv1(client) {
	// Temporadas cuya sheet quedó con un día de emisión corregido en esta pasada: se reparan una sola
	// vez al final (no por cada anime) para no repetir el reordenado de columnas varias veces seguidas.
	const seasonsToRepair = new Set();
	try {
		await deliverPendingNotices(client, seasonsToRepair);
		await checkRecentEpisodes(client, seasonsToRepair);
	} finally {
		for (const clave of seasonsToRepair) {
			const [guildId, ...resto] = clave.split('|');
			const seasonLabel = resto.join('|');
			try {
				await conServidor(guildId, () => repairSeasonTab(seasonLabel));
				console.log(`[scheduler] "${seasonLabel}": columnas reordenadas en la sheet tras corregir día(s) de emisión`);
			} catch (err) {
				console.error(`[scheduler] no pude reordenar "${seasonLabel}" tras corregir día(s) de emisión:`, err.message);
			}
		}
	}
}

function formatProviderAddendum(newProviders, erai) {
	const lines = ['', '**Actualización — nuevos proveedores disponibles:**'];
	for (const [provider, urls] of newProviders.entries()) {
		if (!urls || urls.length === 0) continue;
		lines.push(`\n**${provider}**`);
		for (const u of urls) lines.push(codeBlock(u));
	}
	if (erai) {
		lines.push(`\n**Erai-raws (1080p)**`);
		lines.push(codeBlock(erai.magnet));
	}
	return lines.join('\n');
}

// Un capítulo recién publicado suele tener solo 1Fichier/MP4Upload; Mega y el torrent (Erai-raws)
// aparecen días después. Esto revisa de nuevo los capítulos publicados dentro de
// PROVIDER_RECHECK_MAX_AGE_MS y, si aparecieron proveedores nuevos, edita el mensaje del hilo para
// agregarlos (no manda un mensaje aparte). Deja de revisar un capítulo antes de que venza la ventana
// si ya encontró Mega + el torrent, porque no queda nada más que buscar.
async function checkForNewProviders(client) {
	const due = collectDueEpisodeLinkChecks(PROVIDER_RECHECK_MAX_AGE_MS);
	if (due.length === 0) return;

	for (const entry of due) {
		try {
			if (!entry.slug) continue;

			const knownProviders = new Set(entry.providers ?? []);
			const dl = await getDownloadLinks(entry.slug, entry.episode).catch(() => null);
			const newProviders = new Map();
			if (dl?.providers) {
				for (const [provider, urls] of dl.providers.entries()) {
					if (!knownProviders.has(provider) && urls?.length > 0) newProviders.set(provider, urls);
				}
			}

			const newErai = entry.hasErai ? null : await findEraiMagnet(entry.title, entry.episode).catch(() => null);
			if (newProviders.size === 0 && !newErai) continue;

			const thread = await client.channels.fetch(entry.threadId).catch(() => null);
			const message = thread ? await thread.messages.fetch(entry.messageId).catch(() => null) : null;
			if (!message) {
				// El hilo o el mensaje ya no existen (recreación de temporada, borrado manual, etc): no hay nada que editar.
				deleteEpisodeLinkMessage(entry);
				continue;
			}

			await reabrirSiArchivado(thread);
			await message.edit(`${message.content}${formatProviderAddendum(newProviders, newErai)}`);
			console.log(
				`[scheduler] "${entry.title}" ep. ${entry.episode}: nuevo(s) proveedor(es) agregado(s) al hilo (${[...newProviders.keys()].join(', ') || 'ninguno'}${newErai ? ', Erai-raws' : ''})`,
			);

			const allProviders = [...new Set([...knownProviders, ...newProviders.keys()])];
			const hasErai = entry.hasErai || Boolean(newErai);

			if (allProviders.some((p) => p.toLowerCase() === 'mega') && hasErai) {
				deleteEpisodeLinkMessage(entry);
			} else {
				updateEpisodeLinkMessageProviders({
					guildId: entry.guildId,
					seasonLabel: entry.seasonLabel,
					malId: entry.malId,
					episode: entry.episode,
					providers: allProviders,
					hasErai,
				});
			}
		} catch (err) {
			console.error(`[scheduler] no pude revisar nuevos proveedores para "${entry.title}" ep. ${entry.episode}:`, err.message);
		}
	}
}

// Corre una vez al levantar el bot y luego cada 30 minutos.
function startAv1EpisodeNotifier(client) {
	console.log(`[scheduler] chequeo de animeav1 iniciado, va a chequear cada ${AV1_CHECK_INTERVAL_MS / 60_000} minutos`);

	const runChecks = () => {
		checkAndNotifyAv1(client).catch((err) => console.error('[scheduler] falló el chequeo de animeav1:', err));
		checkForNewProviders(client).catch((err) => console.error('[scheduler] falló el rechequeo de proveedores:', err));
	};

	ensureWarpOnStartup()
		.catch((err) => console.error('[scheduler] falló la reconexión de WARP al arrancar:', err.message))
		.then(runChecks);
	setInterval(runChecks, AV1_CHECK_INTERVAL_MS);
}


module.exports = { startAv1EpisodeNotifier, checkAndNotifyAv1 };
