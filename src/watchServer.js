const http = require('node:http');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
	getDiscordIdForWatchToken,
	getMalIdByAv1MediaId,
	getActiveSeason,
	getUserVote,
	getWatchers,
	setEpisodesWatched,
	getDisplayTitle,
	getAnimeAcrossGuilds,
	getAnimeSeasonsForGuild,
	getAv1ForumThread,
	getVoteState,
	getWatchersWithProgress,
	getNotificationChannel,
	getAllAnime,
	getAvisoPrivadoPreference,
} = require('./services/db');
const { normalizeTitle } = require('./services/animeav1');
const { refrescarCeldaDeProgreso } = require('./sheetProgress');
const { buildAnimeEmbed, buildVoteRow } = require('./components');
const { reabrirSiArchivado } = require('./threadUtil');
const { slugForCustomId } = require('./seasonLabel');
const { rememberSeasonLabel } = require('./seasonCache');

// Solo localhost: la exposición pública pasa por Caddy (reverse proxy con HTTPS) en la Pi, nunca
// directo — mismo patrón que el resto de servicios internos de la Pi.
const PORT = 3005;
const HOST = '127.0.0.1';

// A diferencia de /capitulo (donde el admin elige explícitamente a quién actualiza), acá no sabemos
// en qué guild/temporada corresponde marcar sin mirar dónde tiene voto esa persona. Se prefiere la
// guild donde además esté conectada por voz ahora mismo (si hay varias con voto válido, raro pero
// posible si el bot está en más de un server con el mismo malId activo).
//
// Ojo: no alcanza con mirar solo la temporada ACTIVA de cada guild - alguien puede estar terminando de
// ver un anime de una temporada ya cerrada (ej. uno de verano, visto recién en otoño), y además un
// carryover corregido en una guild pero no en otra deja filas de anime huérfanas en alguna temporada
// donde ese guild en realidad nunca llegó a trackearlo. Por eso se mira en qué temporada(s) ESTE guild
// en particular tiene el anime registrado (getAnimeSeasonsForGuild), no solo si existe algún voto para
// esa temporada en cualquier guild. El server de pruebas (TEST_GUILD_ID) se excluye siempre: marcar un
// capítulo real nunca debería terminar escribiendo contra datos de prueba.
function resolverGuildYSeason(client, discordId, malId) {
	const candidatos = [];
	for (const guild of client.guilds.cache.values()) {
		if (process.env.TEST_GUILD_ID && guild.id === process.env.TEST_GUILD_ID) continue;

		const temporadasDelAnime = getAnimeSeasonsForGuild({ guildId: guild.id, malId });
		if (temporadasDelAnime.length === 0) continue;

		const activa = getActiveSeason(guild.id);
		const seasonLabel = temporadasDelAnime.includes(activa) ? activa : temporadasDelAnime[0];

		const vote = getUserVote({ seasonLabel, malId, discordId });
		if (vote && vote.voteType !== 'rojo') candidatos.push({ guild, seasonLabel });
	}
	if (candidatos.length === 0) return null;
	const enVoz = candidatos.find((c) => c.guild.members.cache.get(discordId)?.voice?.channel);
	return enVoz ?? candidatos[0];
}

// Para capítulos de Erai-raws (torrent) no hay un id interno como el de animeav1 - el watcher solo
// puede sacar el título del nombre del archivo, así que se cruza por título normalizado contra los
// animes trackeados, igual que animeav1.js cruza sus propios títulos contra los de MAL (mismo
// normalizeTitle: mismo manejo de numerales de temporada, acentos, etc). Se prefiere no encontrar
// nada a devolver un anime parecido pero distinto.
function resolverMalIdPorTitulo(title) {
	if (!title) return null;
	const target = normalizeTitle(title);
	const match = getAllAnime().find((a) => normalizeTitle(a.title) === target);
	return match?.malId ?? null;
}

// Marca el capítulo para quien reporta. Al resto de gente que esté en su mismo canal de voz y
// también siga el anime NO se le marca en automático (antes sí, pero eso también marcaba a quien
// estaba ahí haciendo otra cosa sin mirar el capítulo) - en vez de eso, se les ofrece un botón para
// que cada uno confirme por su cuenta que también lo vio (ver handleWatchConfirmButton en
// interactions.js).
async function marcarCapituloParaCanal({ client, discordId, av1MediaId, title, episode }) {
	const malId = av1MediaId != null ? getMalIdByAv1MediaId(av1MediaId) : resolverMalIdPorTitulo(title);
	if (!malId) {
		return {
			ok: false,
			error:
				av1MediaId != null
					? 'No reconozco ese anime (id de animeav1 sin mapear todavía).'
					: `No reconozco "${title}" (el título no cruza con ningún anime que sigas).`,
		};
	}

	const resuelto = resolverGuildYSeason(client, discordId, malId);
	if (!resuelto) return { ok: false, error: 'No tenés un voto registrado para ese anime en ninguna temporada activa.' };
	const { guild, seasonLabel } = resuelto;

	const [anime] = getAnimeAcrossGuilds({ seasonLabel, malId });
	if (!anime) return { ok: false, error: 'No encontré el anime en la base de datos.' };

	// La caché de miembros queda "fría" justo después de reiniciar el bot (discord.js no trae a todo
	// el mundo de entrada) - sin este fetch de respaldo, un reinicio seguido de ver un capítulo antes de
	// volver a interactuar en Discord hacía que esto "funcionara" (ok:true) pero sin marcar a nadie.
	const reportante = guild.members.cache.get(discordId) ?? (await guild.members.fetch(discordId).catch(() => null));
	if (!reportante) return { ok: false, error: 'No te encuentro en el servidor.' };

	const episodesWatched = setEpisodesWatched({ seasonLabel, malId, discordId: reportante.id, displayName: reportante.displayName, episodesWatched: episode });
	const voteReportante = getUserVote({ seasonLabel, malId, discordId: reportante.id });
	if (voteReportante && voteReportante.voteType !== 'rojo') {
		// No lanza nunca (ver sheetProgress.js): hay que mirar .ok a mano, un .catch() acá nunca se
		// dispara aunque falle la escritura en la sheet.
		const resultado = await refrescarCeldaDeProgreso({ seasonLabel, malId, displayName: reportante.displayName, voteType: voteReportante.voteType, episodesWatched });
		if (!resultado.ok) {
			console.error(`[watchServer] no pude refrescar la celda de "${reportante.displayName}" en la sheet:`, resultado.error.message);
		}
	}
	const marcados = [reportante.displayName];

	// Resto del canal de voz que también sigue el anime - estos son a quienes se les ofrece el botón
	// de confirmación, no se les marca directo.
	const canalVoz = reportante.voice?.channel ?? null;
	const watchers = new Set(getWatchers({ seasonLabel, malId }));
	const otros = canalVoz
		? [...canalVoz.members.values()]
				.filter((m) => !m.user.bot && m.id !== reportante.id && watchers.has(m.id))
				.map((m) => ({ id: m.id, displayName: m.displayName }))
		: [];

	const threadId = getAv1ForumThread({ guildId: guild.id, seasonLabel, malId });
	if (threadId) {
		try {
			const thread = await client.channels.fetch(threadId);
			await reabrirSiArchivado(thread);
			const message = await thread.messages.fetch(threadId);
			const voteState = getVoteState({ seasonLabel, malId });
			const progress = getWatchersWithProgress({ seasonLabel, malId });
			await message.edit({
				embeds: [buildAnimeEmbed(anime, { voteState, progress })],
				components: buildVoteRow(seasonLabel, malId, { voteState }),
			});
		} catch (err) {
			console.error(`[watchServer] no pude actualizar el embed del hilo de "${anime.title}":`, err.message);
		}
	}

	// A diferencia de /capitulo (que ya le confirma al propio usuario vía editReply), esto lo dispara
	// un programa externo sin interacción de Discord - sin este aviso, nadie se entera de que se
	// marcó un capítulo salvo mirando el embed a mano. Va al canal de avisos del server (el mismo que
	// usa el scheduler para los avisos de animeav1), no al hilo del foro - el hilo ya se actualiza
	// arriba vía el embed, y este aviso es para que lo vea quien no esté siguiendo ese hilo en concreto.
	//
	// Si quien reporta no está conectado a ningún canal de voz (no está "en Discord" en ese momento) y
	// pidió avisos privados (/vlc-watcher-token aviso-privado:true), se le manda por DM en vez de
	// publicarlo en el canal - sin canalVoz, otros siempre queda vacío, así que no hay botón de
	// confirmación que perder por no usar el canal. Si el DM falla (lo tiene cerrado, por ejemplo) cae
	// al comportamiento de siempre en vez de perder el aviso en silencio.
	let avisadoPorDM = false;
	if (!canalVoz && getAvisoPrivadoPreference(reportante.id)) {
		try {
			await reportante.send(`📺 Marcaste visto el capítulo ${episode} de **${getDisplayTitle(anime)}**.`);
			avisadoPorDM = true;
		} catch (err) {
			console.error(`[watchServer] no pude mandar el DM de confirmación a "${reportante.displayName}", lo aviso en el canal:`, err.message);
		}
	}

	const notificationChannelId = getNotificationChannel(guild.id);
	if (!avisadoPorDM && notificationChannelId) {
		try {
			const canal = await client.channels.fetch(notificationChannelId);
			const seasonSlug = slugForCustomId(seasonLabel);
			rememberSeasonLabel(seasonSlug, seasonLabel);

			let texto = `📺 **${reportante.displayName}** marcó visto el capítulo ${episode} de **${getDisplayTitle(anime)}**.`;
			let components = [];
			if (otros.length > 0) {
				texto += `\n¿${otros.map((o) => `**${o.displayName}**`).join(', ')} también lo visteis?`;
				components = [
					new ActionRowBuilder().addComponents(
						new ButtonBuilder()
							.setCustomId(`watchconfirm:${seasonSlug}:${malId}:${episode}`)
							.setLabel('☑️ Yo también lo vi')
							.setStyle(ButtonStyle.Secondary),
					),
				];
			}
			const mensaje = await canal.send({ content: texto, components });

			if (otros.length === 0) {
				// Nadie más a quien esperar: se autoborra rápido, es solo una confirmación de cortesía.
				setTimeout(() => mensaje.delete().catch(() => {}), 10_000).unref();
			} else {
				// Con botón: no se borra por tiempo, se borra cuando confirme el último que falta (ver
				// handleWatchConfirmButton en interactions.js). El límite de 30 minutos es solo red de
				// seguridad por si alguien nunca llega a pulsar (se fue, no lo vio, etc) - sin esto, un
				// reinicio del bot entre medias también perdería el seguimiento y el mensaje se quedaría
				// colgado para siempre.
				client.watchConfirmPending ??= new Map();
				client.watchConfirmPending.set(mensaje.id, new Set(otros.map((o) => o.id)));
				setTimeout(() => {
					if (client.watchConfirmPending?.delete(mensaje.id)) mensaje.delete().catch(() => {});
				}, 30 * 60_000).unref();
			}
		} catch (err) {
			console.error(`[watchServer] no pude avisar en el canal de "${anime.title}":`, err.message);
		}
	}

	console.log(`[watchServer] "${getDisplayTitle(anime)}" cap. ${episode}: marcado para ${marcados.join(', ') || '(nadie)'}`);
	return { ok: true, titulo: getDisplayTitle(anime), episode, marcados };
}

function leerCuerpo(req, limite = 10_000) {
	return new Promise((resolve, reject) => {
		let body = '';
		req.on('data', (chunk) => {
			body += chunk;
			if (body.length > limite) {
				req.destroy();
				reject(new Error('cuerpo demasiado grande'));
			}
		});
		req.on('end', () => resolve(body));
		req.on('error', reject);
	});
}

function startWatchServer(client) {
	const server = http.createServer(async (req, res) => {
		if (req.method !== 'POST' || req.url !== '/vlc-watched') {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'not found' }));
			return;
		}

		try {
			const body = await leerCuerpo(req);
			const { token, av1MediaId, title, episode } = JSON.parse(body);

			const discordId = token ? getDiscordIdForWatchToken(token) : null;
			if (!discordId) {
				res.writeHead(401, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: 'token inválido' }));
				return;
			}
			// av1MediaId (animeav1) o title (Erai-raws, sin id propio) - uno de los dos, no hace falta
			// ninguna marca explícita de "qué tipo es": si no es un número, se trata como título.
			const tieneAv1MediaId = av1MediaId != null && Number.isFinite(Number(av1MediaId));
			const tieneTitle = typeof title === 'string' && title.trim().length > 0;
			if ((!tieneAv1MediaId && !tieneTitle) || !Number.isFinite(Number(episode))) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: 'falta av1MediaId o title, y episode numérico' }));
				return;
			}

			const resultado = await marcarCapituloParaCanal({
				client,
				discordId,
				av1MediaId: tieneAv1MediaId ? Number(av1MediaId) : null,
				title: tieneAv1MediaId ? null : title.trim(),
				episode: Number(episode),
			});
			// Sin este log, un fallo (anime sin mapear, sin voto registrado, etc.) no deja ningún rastro:
			// la persona ve que "no pasó nada" y no hay forma de saber por qué sin reproducirlo a mano.
			if (!resultado.ok) {
				console.error(`[watchServer] no pude marcar el capítulo (discordId=${discordId}, episode=${episode}):`, resultado.error);
			}
			res.writeHead(resultado.ok ? 200 : 400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(resultado));
		} catch (err) {
			console.error('[watchServer] error procesando la petición:', err.message);
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: false, error: 'error interno' }));
		}
	});

	server.listen(PORT, HOST, () => console.log(`[watchServer] escuchando en ${HOST}:${PORT}`));
	return server;
}

module.exports = { startWatchServer };
