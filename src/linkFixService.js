const { getLinkFixEnabled } = require('./services/db');

// El embed nativo de Discord para links de x.com/twitter.com viene roto (sin imagen/video) desde el
// cambio de API de Twitter. fixvx.com sirve el mismo contenido con un embed que sí funciona; basta
// con reconstruir la misma ruta (usuario/status/id, con query incluida) bajo ese dominio.
const LINK_RE = /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)(\/\S+)/gi;

// Reacción que deja borrar el mensaje reenviado (lo manda un webhook, no el autor original, así que
// Discord no lo trata como "suyo" y no puede borrarlo con el botón normal). TTL de 24h para no
// acumular entradas de mensajes viejos que ya nadie va a borrar.
const PAPELERA_EMOJI = '🗑️';
const borrablePorMensaje = new Map(); // messageId -> authorId
const TTL_BORRADO_MS = 24 * 60 * 60 * 1000;

function registrarBorrable(messageId, authorId) {
	borrablePorMensaje.set(messageId, authorId);
	setTimeout(() => borrablePorMensaje.delete(messageId), TTL_BORRADO_MS).unref();
}

// Un webhook por canal (los hilos no tienen el suyo propio; se reutiliza el del canal padre,
// apuntando con threadId al enviar). Cacheado para no crear uno nuevo en cada link; si alguien lo
// borra a mano desde Discord, se descarta acá y se recrea en el siguiente intento.
const webhookPorCanal = new Map();

// El embed nativo de Discord se rompe sobre todo en tres casos: galería de varias imágenes, video, o
// contenido marcado NSFW por X (a veces ni siquiera intenta mostrarlo). Un tuit de una sola imagen
// normal ya se ve bien nativamente, así que no vale la pena tocarlo. api.fxtwitter.com (el mismo
// servicio de fixvx.com) expone esos datos sin necesitar credenciales de la API de Twitter/X.
// Si la consulta falla o el formato no es el esperado, se prefiere arreglar igual (mejor de más que
// dejar un embed roto sin querer).
async function necesitaArreglo(ruta) {
	try {
		const res = await fetch(`https://api.fxtwitter.com${ruta}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
		const data = await res.json().catch(() => null);

		const tweet = data?.tweet;
		if (!tweet) return true;

		const fotos = tweet.media?.photos?.length ?? 0;
		const tieneVideo = (tweet.media?.videos?.length ?? 0) > 0;
		const esSensible = Boolean(tweet.possibly_sensitive || tweet.nsfw);
		const resultado = fotos > 1 || tieneVideo || esSensible;

		console.log(`[linkFix] ${ruta}: fotos=${fotos} video=${tieneVideo} sensible=${esSensible} -> ${resultado ? 'arreglo' : 'no toco'}`);
		return resultado;
	} catch (err) {
		console.error(`[linkFix] no pude consultar fxtwitter para ${ruta}, arreglo igual:`, err.message);
		return true;
	}
}

async function obtenerOCrearWebhook(canalBase) {
	if (webhookPorCanal.has(canalBase.id)) return webhookPorCanal.get(canalBase.id);

	const webhooks = await canalBase.fetchWebhooks();
	let webhook = webhooks.find((w) => w.owner?.id === canalBase.client.user.id);
	if (!webhook) webhook = await canalBase.createWebhook({ name: 'LinkFix' });

	webhookPorCanal.set(canalBase.id, webhook);
	return webhook;
}

// Si el mensaje trae un link de x.com/twitter.com y /link-fix está activado en el servidor: borra el
// original y lo reenvía como versión fixvx.com vía webhook con el nombre/avatar de quien lo escribió,
// para que quede claro quién lo mandó sin que parezca dicho por el bot.
async function handleMessage(message) {
	const guildId = message.guildId;
	if (!guildId || message.webhookId || message.author?.bot) return;

	const contenido = message.content ?? '';
	const coincidencias = [...contenido.matchAll(LINK_RE)];
	if (coincidencias.length === 0) return;

	try {
		if (!getLinkFixEnabled(guildId)) return;

		// Sin "Gestionar mensajes" el bot no puede borrar el original: no se hace nada (ni se
		// responde), porque un link fixvx.com al lado del roto sin borrar sería peor que no tocar nada.
		const permisos = message.channel.permissionsFor(message.guild.members.me);
		if (!permisos?.has('ManageMessages')) return;

		// Un mismo link puede aparecer repetido (copiado/pegado dos veces); no tiene sentido
		// consultarlo/responder dos veces.
		const rutas = [...new Set(coincidencias.map((m) => m[1]))];
		const chequeos = await Promise.all(rutas.map((ruta) => necesitaArreglo(ruta)));
		const rutasAArreglar = rutas.filter((_, i) => chequeos[i]);

		// Ninguno de los links necesita el reemplazo (una sola imagen normal, sin video ni NSFW): se
		// deja el mensaje original tal cual, su embed nativo ya se ve bien.
		if (rutasAArreglar.length === 0) return;

		// Sustituye SOLO los links que necesitan arreglo, en el lugar donde estaban dentro del texto
		// completo (no reconstruye el mensaje desde cero): así se conserva cualquier otra cosa que haya
		// escrito la persona (comentario, @menciones, links que no necesitaban arreglo) en vez de perderla.
		const rutasAArreglarSet = new Set(rutasAArreglar);
		const contenidoFinal = contenido.replace(LINK_RE, (coincidenciaCompleta, ruta) =>
			rutasAArreglarSet.has(ruta) ? `https://fixvx.com${ruta}` : coincidenciaCompleta,
		);

		const esHilo = message.channel.isThread();
		const canalBase = esHilo ? message.channel.parent : message.channel;

		const opcionesEnvio = {
			content: contenidoFinal,
			username: message.member?.displayName || message.author.username,
			// forceStatic: sin esto, discord.js ignora extension:'png' cuando el avatar es animado (hash
			// "a_...") y devuelve igual un .gif — visto en un caso real donde el ícono del webhook no
			// terminaba de renderizar bien. Un .png estático siempre es válido como ícono de webhook.
			avatarURL: message.author.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }),
			allowedMentions: { parse: ['users', 'roles'] },
		};
		if (esHilo) opcionesEnvio.threadId = message.channel.id;

		console.log(`[linkFix] username="${opcionesEnvio.username}" avatarURL=${opcionesEnvio.avatarURL}`);

		let mensajeEnviado = null;
		if (canalBase && permisos?.has('ManageWebhooks')) {
			try {
				const webhook = await obtenerOCrearWebhook(canalBase);
				mensajeEnviado = await webhook.send(opcionesEnvio);
			} catch (errorWebhook) {
				// El webhook cacheado pudo borrarse a mano desde Discord: se descarta y se cae al
				// respaldo (mandarlo como el propio bot) en vez de perder el link.
				webhookPorCanal.delete(canalBase.id);
				console.error('[linkFix] no pude usar el webhook, uso fallback:', errorWebhook.message);
			}
		}

		if (!mensajeEnviado) {
			mensajeEnviado = await message.channel.send({ content: contenidoFinal, allowedMentions: { parse: ['users', 'roles'] } });
		}

		registrarBorrable(mensajeEnviado.id, message.author.id);
		await mensajeEnviado.react(PAPELERA_EMOJI).catch(() => {});

		// Solo se borra el original una vez que la sustitución ya se envió con éxito.
		await message.delete().catch(() => {});
	} catch (error) {
		console.error('[linkFix] error al revisar el link:', error.message);
	}
}

// Reacción 🗑️ sobre un mensaje reenviado por /link-fix: solo el autor original puede borrarlo así
// (sin excepción para "Gestionar mensajes" — en un server chico ese permiso lo puede tener cualquiera,
// no solo moderadores, así que no sirve como filtro real).
async function handleReactionAdd(reaction, reactorUser) {
	// El propio bot reacciona con esta misma reacción al mandar el mensaje (mensajeEnviado.react(...)
	// más abajo), y eso también dispara este evento — sin este chequeo, el bot borraría su propio
	// mensaje al instante.
	if (reactorUser.bot) return;
	if (reaction.emoji.name !== PAPELERA_EMOJI) return;

	const authorId = borrablePorMensaje.get(reaction.message.id);
	if (!authorId) return;
	if (reactorUser.id !== authorId) return;

	borrablePorMensaje.delete(reaction.message.id);
	await reaction.message.delete().catch(() => {});
}

module.exports = { handleMessage, handleReactionAdd };
