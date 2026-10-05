const { getLinkFixSitesEnabled } = require('./services/db');
const { AttachmentBuilder } = require('discord.js');

// El embed nativo de Discord para links de x.com/twitter.com viene roto (sin imagen/video) desde el
// cambio de API de Twitter. fixvx.com sirve el mismo contenido con un embed que sí funciona; basta
// con reconstruir la misma ruta (usuario/status/id, con query incluida) bajo ese dominio.
// Lo mismo aplica a otros sitios con embeds pobres: cada uno tiene su propio interruptor por servidor
// (/link-fix sitio:<x>), 'x' es el original. Solo 'x' pasa por necesitaArreglo (los demás siempre se
// reescriben). keepSub conserva un subdominio significativo (vm.tiktok.com, usuario.tumblr.com); en el
// resto se descarta (mobile.twitter.com, old.reddit.com...).
// Twitch clips y Threads no están: no se pudo verificar que sus dominios "fix" existan/respondan.
const SITIOS = {
	x: { dominios: ['x\\.com', 'twitter\\.com'], host: 'fixvx.com', keepSub: false, verificar: true },
	// tiktokez (EmbedEZ) en vez de tnktok (2026-09-30, portado de Aurora): es de los pocos
	// servicios que usamos que traduce por URL. Se le añade SIEMPRE /es (ver traducirSiempre más
	// abajo) porque este bot habla en castellano.
	// OJO: su traducción también traduce los HASHTAGS (#zonagemelos -> algo distinto), así que
	// dejan de ser el hashtag real; y sobre un vídeo que YA está en castellano, el paso por el
	// traductor puede reformular la frase sin necesidad (comprobado: "De que banda sois?" salió
	// como "¿En qué banda estás?"). Se acepta a cambio de entender los vídeos en otros idiomas.
	// El vídeo se sigue reproduciendo (sirve og:video).
	tiktok: { dominios: ['tiktok\\.com'], host: 'tiktokez.com', keepSub: true, traducirSiempre: true },
	instagram: { dominios: ['instagram\\.com'], host: 'kkinstagram.com', keepSub: false },
	reddit: { dominios: ['reddit\\.com'], host: 'rxddit.com', keepSub: false },
	bluesky: { dominios: ['bsky\\.app'], host: 'bskx.app', keepSub: false },
	// embedPropio: ver construirEmbedDesdeOg. Discord pinta og:site_name como pie del embed, y
	// phixiv pone ahí la URL de su repo de GitHub, que sale en todos los mensajes. El embed es
	// suyo y no se puede editar, así que se evita que Discord lo genere y se publica uno propio
	// (solo título + imagen). Portado de Aurora, 2026-09-30.
	pixiv: { dominios: ['pixiv\\.net'], host: 'phixiv.net', keepSub: false, embedPropio: true },
	tumblr: { dominios: ['tumblr\\.com'], host: 'tpmblr.com', keepSub: true },
	// facebookez.com (el host anterior) quedó SECUESTRADO: responde 200 con cero bytes al
	// crawler de Discord y redirige a las personas a una red de anuncios
	// (profitablecpmratenetwork.com) desde CUALQUIER ruta. Como el bot borra el original y
	// reenvía el reescrito, eso mandaba a la gente a los anuncios sin poder volver al link
	// bueno. Sustituido (2026-09-30, portado de Aurora) por facebed.seria.moe: comprobado que
	// sirve og: al crawler y que a las personas las redirige al facebook.com real.
	facebook: { dominios: ['facebook\\.com'], host: 'facebed.seria.moe', keepSub: false },
};
for (const sitio of Object.values(SITIOS)) {
	// grupos: 1 = subdominio (con punto final, o ''), 2 = ruta completa
	sitio.regex = new RegExp(`https?:\\/\\/(?:www\\.)?((?:[\\w-]+\\.)*)(?:${sitio.dominios.join('|')})(\\/\\S+)`, 'gi');
}

// FxTwitter (y EmbedEZ/tiktokez, que usa el mismo mecanismo) solo traducen si se les añade el
// idioma destino al final de la RUTA, antes de la query: /usuario/status/123/es?s=20. Sin ese
// sufijo devuelven el texto original. Se añade solo cuando el contenido NO está ya en castellano
// (idioma destino de ESTE bot, a diferencia de Aurora que traduce a inglés): sobre algo ya en
// castellano el sufijo debería ser inocuo, aunque en la práctica el traductor a veces reformula
// igual una frase que ya estaba bien (ver el comentario de tiktok en SITIOS).
const IDIOMA_TRADUCCION = 'es';

// Códigos que X devuelve cuando NO hay un idioma real que traducir (tuit sin texto: solo media,
// menciones, hashtags...). Pedir /und o /zxx no traduciría nada, y sin este filtro el bot
// reescribiría esos mensajes (borrar + reenviar) a cambio de nada.
const IDIOMAS_SIN_TRADUCCION = new Set(['und', 'zxx', 'qam', 'qct', 'qht', 'qme', 'qst']);
const necesitaTraduccion = (idioma) => Boolean(idioma) && idioma !== IDIOMA_TRADUCCION && !IDIOMAS_SIN_TRADUCCION.has(idioma);

// Inserta el idioma ANTES de la query: /u/status/1?s=20 -> /u/status/1/es?s=20
function insertarIdioma(ruta) {
	const corte = ruta.indexOf('?');
	let camino = corte === -1 ? ruta : ruta.slice(0, corte);
	while (camino.endsWith('/')) camino = camino.slice(0, -1);
	const query = corte === -1 ? '' : ruta.slice(corte);
	return `${camino}/${IDIOMA_TRADUCCION}${query}`;
}

const conTraduccion = (ruta, idioma) => (necesitaTraduccion(idioma) ? insertarIdioma(ruta) : ruta);

// Embed propio a partir de los metadatos Open Graph del sitio "fix" (ver embedPropio en
// SITIOS). Se piden los mismos datos que pediría Discord (de ahí el User-Agent de su crawler) y
// se monta un embed sin el pie que pone el sitio. No se descarga la imagen: se le pasa a Discord
// la URL de og:image y la trae él, así que esto cuesta una petición de texto y nada más.
// Portado de Aurora/LinkFixService.js, 2026-09-30.
const TIMEOUT_OG_MS = 6000;
const MAX_EMBEDS_PROPIOS = 4; // Discord admite 10 por mensaje; 4 ya es un mensaje muy cargado
const UA_CRAWLER = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';

function decodificarEntidades(texto) {
	return texto
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
		.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&'); // el último, o desharía las entidades ya decodificadas
}

function leerMeta(html, propiedad) {
	// property="og:x" content="..." y también el orden inverso, que algunos sitios usan.
	const directo = html.match(new RegExp(`<meta[^>]+property=["']${propiedad}["'][^>]+content=["']([^"']*)["']`, 'i'));
	const inverso = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${propiedad}["']`, 'i'));
	const valor = (directo || inverso)?.[1];
	return valor ? decodificarEntidades(valor) : null;
}

// @returns el embed listo, o null si no se pudo (se cae al link normal).
async function construirEmbedDesdeOg(enlaceFix) {
	try {
		const res = await fetch(enlaceFix, { headers: { 'User-Agent': UA_CRAWLER }, signal: AbortSignal.timeout(TIMEOUT_OG_MS) });
		if (!res.ok) return null;
		const html = await res.text();
		const imagen = leerMeta(html, 'og:image');
		if (!imagen) return null; // sin imagen no aporta nada sobre el link pelado

		// Título e imagen, SIN descripción: en Pixiv, og:description son las etiquetas de la obra
		// (a veces decenas, o párrafos en obras con descripción larga) y ocupaba media pantalla.
		// og:url apunta al sitio ORIGINAL (pixiv.net), no a phixiv: es adonde debe llevar el título.
		const embed = { url: leerMeta(html, 'og:url') || enlaceFix, image: { url: imagen } };
		const titulo = leerMeta(html, 'og:title');
		if (titulo) embed.title = titulo.slice(0, 256);
		return embed;
	} catch {
		return null; // red, timeout o HTML raro: mejor el link de siempre que nada
	}
}

// Discord SIEMPRE deja separación entre imágenes distintas: mandando las 4 sueltas salen en
// rejilla 2x2 con huecos, que parte la composición del dibujo. x.com no hace nada especial - le
// sirve a Discord UNA sola imagen ya compuesta, y por eso su embed se ve continuo. Aquí se cose
// la tira con sharp para reproducirlo. Portado de Aurora/LinkFixService.js, 2026-09-30.
const ALTO_TIRA = 600; // alto común al que se escalan todas las fotos
const MAX_FOTOS_GALERIA = 4; // X no admite más de 4 fotos por tuit
const MAX_PESO_FOTOS = 12 * 1024 * 1024; // tope de descarga: si se pasa, se cae al link
const TIMEOUT_FOTO_MS = 8000;

// X sirve el mismo `media.url` con `?name=orig` (resolución completa, varios MB). La tira
// solo necesita ALTO_TIRA (600px) de alto, así que bajar `orig` a `medium` (lado largo ~1200px)
// ahorra la mayoría del peso de descarga y del trabajo de decodificar en sharp, sin que se note
// en una tira que de todas formas termina a 600px. Si la URL no tiene el parámetro (otro CDN o
// formato inesperado) se deja igual.
function urlFotoParaTira(url) {
	try {
		const u = new URL(url);
		if (u.searchParams.has('name')) u.searchParams.set('name', 'medium');
		return u.toString();
	} catch {
		return url;
	}
}

async function componerTiraHorizontal(urls) {
	try {
		const sharp = require('sharp');

		// Las descargas van en paralelo (antes eran secuenciales, una tras otra: con 3-4
		// fotos eso solo en red ya sumaba 1-2s). El tope de peso se comprueba una vez bajadas
		// todas: como máximo son MAX_FOTOS_GALERIA, no vale la pena cortar a mitad de camino.
		const originales = await Promise.all(
			urls.slice(0, MAX_FOTOS_GALERIA).map(async (u) => {
				const r = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT_FOTO_MS) });
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return Buffer.from(await r.arrayBuffer());
			}),
		);
		const total = originales.reduce((suma, b) => suma + b.length, 0);
		if (total > MAX_PESO_FOTOS) throw new Error('las fotos pesan demasiado');

		// Mismo alto para todas: así la tira queda alineada aunque las fotos vengan con tamaños
		// distintos (el ancho de cada una lo marca su propia proporción).
		const piezas = await Promise.all(
			originales.map((b) => sharp(b).resize({ height: ALTO_TIRA }).toBuffer({ resolveWithObject: true })),
		);

		let x = 0;
		const capas = piezas.map((p) => {
			const capa = { input: p.data, left: x, top: 0 };
			x += p.info.width;
			return capa;
		});

		return await sharp({ create: { width: x, height: ALTO_TIRA, channels: 3, background: { r: 0, g: 0, b: 0 } } })
			.composite(capas)
			.jpeg({ quality: 85 })
			.toBuffer();
	} catch (err) {
		return null; // red, peso o sharp: se cae al link reescrito, nunca peor que antes
	}
}

// ¿Merece la pena coser la tira, o es mejor el link de siempre y que Discord monte su rejilla?
// Como todas las fotos se escalan al MISMO alto (ver ALTO_TIRA), el ancho total es la suma de
// sus relaciones de aspecto - y Discord pinta la imagen de un embed a unos 550px de ancho, así
// que cuanto más ancha sea la tira, más baja se ve. Pasada la relación 3 la banda queda tan baja
// que no se distingue nada, y la rejilla 2x2 de Discord se ve mucho mejor (medido en Aurora).
const MAX_RELACION_TIRA = 3;

function tiraSeVeBien(fotos) {
	// Sin medidas no se puede calcular: mejor el camino de siempre que una tira posiblemente ilegible.
	if (!fotos.every((f) => f.width > 0 && f.height > 0)) return false;
	return fotos.reduce((suma, f) => suma + f.width / f.height, 0) <= MAX_RELACION_TIRA;
}

// Cabecera del tuit (autor, avatar y texto ya traducido) - la usa la galería propia.
function construirEmbedCabecera(enlaceOriginal, datos) {
	const embed = { url: enlaceOriginal, author: { name: `${datos.autor} (@${datos.usuario})`.slice(0, 256), url: enlaceOriginal } };
	if (datos.avatar) embed.author.icon_url = datos.avatar;
	if (datos.texto) embed.description = datos.texto.slice(0, 4000);
	return embed;
}

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
// Se pide SIEMPRE con /es (ver insertarIdioma): si el tuit no está en castellano la respuesta trae
// además el campo `translation` (texto ya traducido para la galería), y si ya lo está no cambia
// nada. Así sigue siendo UNA sola llamada, no dos. Portado de Aurora, 2026-09-30.
async function necesitaArreglo(ruta) {
	try {
		const res = await fetch(`https://api.fxtwitter.com${insertarIdioma(ruta)}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
		const data = await res.json().catch(() => null);

		const tweet = data?.tweet;
		if (!tweet) {
			console.log(`[linkFix] ${ruta}: la respuesta no traía tweet (http ${res.status})`);
			return { arreglar: true, idioma: null, galeria: null };
		}

		const fotos = tweet.media?.photos?.length ?? 0;
		const tieneVideo = (tweet.media?.videos?.length ?? 0) > 0;
		const esSensible = Boolean(tweet.possibly_sensitive || tweet.nsfw);
		// Con vídeo NO se usa la galería propia, ni aunque además traiga fotos: un embed de
		// Discord no reproduce vídeo, así que montarla perdería lo principal del tuit.
		const galeria = fotos > 1 && !tieneVideo && tweet.author && tiraSeVeBien(tweet.media.photos) ? {
			fotos: tweet.media.photos.map((f) => urlFotoParaTira(f.url)),
			autor: tweet.author.name || '',
			usuario: tweet.author.screen_name || '',
			avatar: tweet.author.avatar_url || null,
			texto: tweet.translation?.text || tweet.text || '',
		} : null;

		const resultado = fotos > 1 || tieneVideo || esSensible || necesitaTraduccion(tweet.lang);
		console.log(`[linkFix] ${ruta}: fotos=${fotos} video=${tieneVideo} sensible=${esSensible} lang=${tweet.lang} -> ${resultado ? 'arreglo' : 'no toco'}`);
		return { arreglar: resultado, idioma: tweet.lang || null, galeria };
	} catch (err) {
		console.error(`[linkFix] no pude consultar fxtwitter para ${ruta}, arreglo igual:`, err.message);
		return { arreglar: true, idioma: null, galeria: null };
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

// Si el mensaje trae un link de un sitio soportado y /link-fix está activado en el servidor: borra
// el original y lo reenvía como versión "fix" vía webhook con el nombre/avatar de quien lo escribió,
// para que quede claro quién lo mandó sin que parezca dicho por el bot.
async function handleMessage(message) {
	const guildId = message.guildId;
	if (!guildId || message.webhookId || message.author?.bot) return;

	const contenido = message.content ?? '';
	if (!contenido.includes('://')) return;

	// Instrumentación temporal: el bot tarda "varios segundos" en aplicar el arreglo y hay que ver
	// en qué paso se va el tiempo (consulta a fxtwitter, webhook, galería...) antes de tocar nada.
	const inicio = Date.now();
	const marcar = (paso) => console.log(`[linkFix] +${Date.now() - inicio}ms ${paso}`);

	try {
		const sitiosActivos = getLinkFixSitesEnabled(guildId);
		if (sitiosActivos.size === 0) return;

		// Un link entre <...> es un embed suprimido a propósito por quien escribe: no se toca.
		const coincidencias = [];
		for (const [clave, sitio] of Object.entries(SITIOS)) {
			if (!sitiosActivos.has(clave)) continue;
			for (const m of contenido.matchAll(sitio.regex)) {
				if (contenido[m.index - 1] === '<') continue;
				coincidencias.push({ sitio, texto: m[0], sub: m[1], ruta: m[2], index: m.index });
			}
		}
		if (coincidencias.length === 0) return;

		// Sin "Gestionar mensajes" el bot no puede borrar el original: no se hace nada (ni se
		// responde), porque un link al lado del roto sin borrar sería peor que no tocar nada.
		const permisos = message.channel.permissionsFor(message.guild.members.me);
		if (!permisos?.has('ManageMessages')) return;

		const esHilo = message.channel.isThread();
		const canalBase = esHilo ? message.channel.parent : message.channel;

		// Se lanza ya (sin esperarlo) en paralelo con la consulta a fxtwitter y, si aplica, la
		// composición de la galería: así su tiempo de red (fetchWebhooks la primera vez por canal)
		// no se SUMA al de esas otras esperas. Si al final no hay nada que arreglar, se deja correr
		// sin usar (es barato) en vez de complicar el código para cancelarlo.
		const webhookPromise = (canalBase && permisos.has('ManageWebhooks'))
			? obtenerOCrearWebhook(canalBase).catch(() => null)
			: Promise.resolve(null);

		// Un mismo link puede aparecer repetido (copiado/pegado dos veces); no tiene sentido
		// consultarlo dos veces. Solo X pasa por necesitaArreglo (una imagen normal se ve bien
		// nativamente; el resto siempre se reescribe).
		const rutasX = [...new Set(coincidencias.filter((c) => c.sitio.verificar).map((c) => c.ruta))];
		const analisisX = await Promise.all(rutasX.map((ruta) => necesitaArreglo(ruta)));
		const infoX = new Map(rutasX.map((ruta, i) => [ruta, analisisX[i]]));
		marcar(`fxtwitter respondido (${rutasX.length} ruta/s)`);

		const aArreglar = coincidencias
			.filter((c) => !c.sitio.verificar || infoX.get(c.ruta)?.arreglar)
			.sort((a, b) => a.index - b.index);

		// Ninguno de los links necesita el reemplazo: se deja el mensaje original tal cual.
		if (aArreglar.length === 0) return;

		// Sustituye SOLO los links que necesitan arreglo, en el lugar donde estaban dentro del texto
		// completo (no reconstruye el mensaje desde cero): así se conserva cualquier otra cosa que haya
		// escrito la persona (comentario, @menciones, links que no necesitaban arreglo) en vez de perderla.
		let contenidoFinal = '';
		let cursor = 0;
		let galeriaPendiente = null;
		const embedsPendientes = []; // links con embedPropio (ver construirEmbedDesdeOg), a resolver después
		for (const c of aArreglar) {
			const info = c.sitio.verificar ? infoX.get(c.ruta) : null;
			let reemplazo;
			if (info?.galeria && galeriaPendiente === null) {
				// Galería propia (ver componerTiraHorizontal): el link va entre <> para que Discord
				// NO monte además su embed automático. Solo la PRIMERA galería del mensaje.
				galeriaPendiente = { galeria: info.galeria, link: c.texto };
				reemplazo = `<${c.texto}>`;
			} else if (c.sitio.embedPropio && embedsPendientes.length < MAX_EMBEDS_PROPIOS) {
				const sub = c.sitio.keepSub ? c.sub : '';
				const enlaceFix = `https://${sub}${c.sitio.host}${c.ruta}`;
				// Entre <> para que Discord no monte el embed del sitio (con su pie); el nuestro se
				// añade más abajo. Si la petición falla se deshace el <>.
				embedsPendientes.push(enlaceFix);
				reemplazo = `<${enlaceFix}>`;
			} else {
				const sub = c.sitio.keepSub ? c.sub : '';
				let ruta = c.ruta;
				if (c.sitio.verificar) ruta = conTraduccion(c.ruta, info?.idioma);
				else if (c.sitio.traducirSiempre) ruta = insertarIdioma(c.ruta);
				reemplazo = `https://${sub}${c.sitio.host}${ruta}`;
			}
			contenidoFinal += contenido.slice(cursor, c.index) + reemplazo;
			cursor = c.index + c.texto.length;
		}
		contenidoFinal += contenido.slice(cursor);

		// Coser la tira: una sola vez y fuera del bucle. Si falla (red, peso, sharp) se deshace el
		// <> y el link vuelve a ir reescrito, exactamente como antes de existir la galería.
		let adjuntos = [];
		let embeds = [];
		if (galeriaPendiente) {
			const tira = await componerTiraHorizontal(galeriaPendiente.galeria.fotos);
			if (tira) {
				adjuntos = [new AttachmentBuilder(tira, { name: 'galeria.jpg' })];
				embeds = [{
					...construirEmbedCabecera(galeriaPendiente.link, galeriaPendiente.galeria),
					image: { url: 'attachment://galeria.jpg' },
				}];
			} else {
				contenidoFinal = contenidoFinal.replace(`<${galeriaPendiente.link}>`, galeriaPendiente.link);
			}
		}
		if (galeriaPendiente) marcar(`galeria compuesta`);

		// Embeds propios (Pixiv, etc.): en paralelo (peticiones de texto cortas). El que falle
		// vuelve a ser un link normal, deshaciendo su <> — el mensaje nunca se queda sin el link.
		if (embedsPendientes.length > 0) {
			const resultados = await Promise.all(embedsPendientes.map(construirEmbedDesdeOg));
			resultados.forEach((embed, i) => {
				if (embed) embeds.push(embed);
				else contenidoFinal = contenidoFinal.replace(`<${embedsPendientes[i]}>`, embedsPendientes[i]);
			});
		}
		if (embedsPendientes.length > 0) marcar(`embeds propios resueltos (${embedsPendientes.length})`);

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
		if (embeds.length > 0) opcionesEnvio.embeds = embeds;
		if (adjuntos.length > 0) opcionesEnvio.files = adjuntos;

		console.log(`[linkFix] username="${opcionesEnvio.username}" avatarURL=${opcionesEnvio.avatarURL}`);

		let mensajeEnviado = null;
		const webhook = await webhookPromise;
		if (webhook) {
			try {
				mensajeEnviado = await webhook.send(opcionesEnvio);
			} catch (errorWebhook) {
				// El webhook cacheado pudo borrarse a mano desde Discord: se descarta y se cae al
				// respaldo (mandarlo como el propio bot) en vez de perder el link.
				webhookPorCanal.delete(canalBase.id);
				console.error('[linkFix] no pude usar el webhook, uso fallback:', errorWebhook.message);
			}
		}

		if (!mensajeEnviado) {
			const opcionesFallback = { content: contenidoFinal, allowedMentions: { parse: ['users', 'roles'] } };
			if (embeds.length > 0) opcionesFallback.embeds = embeds;
			if (adjuntos.length > 0) opcionesFallback.files = adjuntos;
			mensajeEnviado = await message.channel.send(opcionesFallback);
		}
		marcar(`mensaje reenviado`);

		registrarBorrable(mensajeEnviado.id, message.author.id);

		// Reacción y borrado del original no dependen entre sí: en paralelo para no sumar sus
		// tiempos de ida y vuelta a la API de Discord. Solo se borra una vez que la sustitución ya
		// se envió con éxito (eso ya pasó arriba).
		await Promise.all([
			mensajeEnviado.react(PAPELERA_EMOJI).catch(() => {}),
			message.delete().catch(() => {}),
		]);
		marcar(`listo (reacción + borrado)`);
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

module.exports = { handleMessage, handleReactionAdd, SITIOS_LINKFIX: Object.keys(SITIOS) };
