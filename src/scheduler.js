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
	recordEpisodeLinkMessage,
	updateEpisodeLinkMessageProviders,
	deleteEpisodeLinkMessage,
	collectDueEpisodeLinkChecks,
} = require('./services/db');

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { updateAnimeDay, repairSeasonTab } = require('./services/sheets');
const { getRecentlyUpdatedEpisodes, normalizeTitle, getCoverImage, getDownloadLinks } = require('./services/animeav1');
const { findEraiMagnet } = require('./services/nyaa');

const { buildEpisodeButtonRow } = require('./components');
const { rememberAnime } = require('./seasonCache');

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

				// Publicación en el hilo del anime dentro del foro de la temporada. Se hace ANTES del aviso
				// del canal general para poder linkear, desde ahí, directo al mensaje del capítulo en el
				// hilo (no solo al hilo en general).
				// Reglas:
				// - solo lo publicamos cuando detectamos un episodio nuevo (ya está dedupeado con av1NotifiedEpisodes)
				// - si no existe threadId registrado, no rompemos el aviso semanal
				let threadMessageUrl = null;
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
								for (const u of urls) lines.push(codeBlock(u));
							}

							// El magnet es un extra: si nyaa.one falla o no tiene el release, el mensaje sale
							// igual solo con lo de animeav1.
							const erai = await findEraiMagnet(entry.title, av1Entry.episode).catch(() => null);
							if (erai) {
								lines.push(`\n**Erai-raws (1080p)**`);
								lines.push(codeBlock(erai.magnet));
							}

							const msg = lines.filter(Boolean).join('\n');
							const threadMessage = await thread.send(msg);
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
								providers: [...dl.providers.keys()],
								hasErai: Boolean(erai),
							});
						}
					}
				}

				// Sin la portada el aviso igual sirve, así que un fallo de red acá no debe frenarlo.
				const cover = await getCoverImage(av1Entry.slug).catch(() => null);
				const embed = new EmbedBuilder()
					.setTitle(entry.title)
					.setURL(av1Entry.url)
					.setDescription(`Episodio **${av1Entry.episode}** disponible en animeav1`)
					.setColor(0x2b6cb0);
				if (cover) embed.setImage(cover);

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

	runChecks();
	setInterval(runChecks, AV1_CHECK_INTERVAL_MS);
}

module.exports = { startAv1EpisodeNotifier };
