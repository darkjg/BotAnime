const { av1Fetch } = require('./av1Net');

const HOME_URL = 'https://animeav1.com/';
const UPDATED_HEADING = 'Recientemente Actualizado';
const ADDED_HEADING = 'Recientemente Agregados';

// animeav1 no tiene API/RSS: hay que leer el HTML de la home. Cada tarjeta del bloque "Recientemente
// Actualizado" trae un <a href="/media/<slug>/<episodio>"> con un <span class="sr-only">Ver <Título>
// <episodio></span> al lado; de ahí sacamos slug/episodio/título sin depender de las clases de
// Tailwind, que cambian con cada rediseño y romperían el parseo.
const ENTRY_RE = /href="(\/media\/([a-z0-9-]+)\/(\d+))"><span class="sr-only">Ver ([^<]+?) \d+<\/span>/g;

// Devuelve los episodios listados en "Recientemente Actualizado" (los últimos publicados en el
// sitio), no toda la lista de animes del catálogo.
async function getRecentlyUpdatedEpisodes() {
	const res = await av1Fetch(HOME_URL);
	if (!res.ok) throw new Error(`animeav1 respondió ${res.status}`);
	const html = await res.text();

	const start = html.indexOf(UPDATED_HEADING);
	if (start === -1) return [];
	const end = html.indexOf(ADDED_HEADING, start);
	const section = end === -1 ? html.slice(start) : html.slice(start, end);

	const entries = [];
	let match;
	ENTRY_RE.lastIndex = 0;
	while ((match = ENTRY_RE.exec(section))) {
		entries.push({ title: match[4], slug: match[2], episode: Number(match[3]), url: `https://animeav1.com${match[1]}` });
	}
	return entries;
}

// MAL (Jikan) numera las temporadas como "2nd Season", "3rd Season"... pero animeav1 usa numeral
// romano al final del título ("... II", "... III"). Sin esto, un anime como "Tensei Shitara Ken
// Deshita 2nd Season" (MAL) vs "Tensei shitara Ken deshita II" (animeav1) no cruza nunca y el bot
// no manda ningún aviso para él, en silencio (bug real detectado en Otoño 2026).
const ROMAN_TO_NUM = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

// Normaliza títulos (sin acentos/puntuación, en minúscula, numeral de temporada unificado) para
// cruzar el nombre que usa animeav1 contra el título que guardamos de MAL sin exigir que coincidan
// carácter por carácter.
function normalizeTitle(title) {
	let normalized = title
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/(\d+)(?:st|nd|rd|th)\s+season/g, 'season $1')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();

	const words = normalized.split(' ');
	const last = words[words.length - 1];
	if (words.length > 1 && Object.prototype.hasOwnProperty.call(ROMAN_TO_NUM, last)) {
		words[words.length - 1] = `season ${ROMAN_TO_NUM[last]}`;
		normalized = words.join(' ');
	}

	return normalized;
}

// En la ficha de cada anime (/media/<slug>) la portada es el único <img> con la clase
// "aspect-poster"; el resto de <img> de la página son logos, backdrop, recomendaciones o capturas.
const COVER_RE = /<img class="aspect-poster[^"]*"[^>]*src="([^"]+)"/;

// Devuelve la URL de la portada de un anime a partir de su slug, o null si la ficha no existe
// o cambió de estructura.
async function getCoverImage(slug) {
	const res = await av1Fetch(`https://animeav1.com/media/${slug}`);
	if (!res.ok) return null;
	const html = await res.text();
	const match = html.match(COVER_RE);
	return match?.[1] ?? null;
}

// El id interno de animeav1 (NO el slug) — no sale en ninguna URL visible, pero viene embebido en el
// bloque de datos de SvelteKit de la propia ficha: media:{id:197,categoryId:1,title:"One Piece",...}.
// Sirve para identificar qué anime es un archivo descargado de animeav1: el nombre que deja al
// descargar un capítulo es "<id>_<capitulo>_SUB" (o _DUB), sin el título — comprobado en vivo
// 2026-10-05 con One Piece (id 197) y Youjo Senki II (id 4417). No hay otra forma de sacar este id
// más que leerlo de la ficha, así que se guarda en BD la primera vez (ver setAv1MediaId) para no
// tener que volver a pedirlo.
const MEDIA_ID_RE = /media:\{id:(\d+),categoryId:\d+,title:"/;

async function getMediaId(slug) {
	const res = await av1Fetch(`https://animeav1.com/media/${slug}`);
	if (!res.ok) return null;
	const html = await res.text();
	const match = html.match(MEDIA_ID_RE);
	return match ? Number(match[1]) : null;
}

// La ficha trae el malId del propio anime (`...",malId:63431,seasons:`); los de los géneros van seguidos de `}`.
// Sirve para cruzar animes que animeav1 lista con otro nombre que MAL (ej. "Chii Fuyo"). Cacheado por slug.
const MAL_ID_RE = /,malId:(\d+),seasons:/;
const malIdCache = new Map();

async function getMalIdBySlug(slug) {
	if (malIdCache.has(slug)) return malIdCache.get(slug);
	const res = await av1Fetch(`https://animeav1.com/media/${slug}`);
	if (!res.ok) return null; // sin cachear: puede ser un fallo pasajero
	const match = (await res.text()).match(MAL_ID_RE);
	const malId = match ? Number(match[1]) : null;
	malIdCache.set(slug, malId);
	return malId;
}

// Slug de un anime en emisión que animeav1 lista con otro nombre que MAL: recorre "Recientemente
// Actualizado" y se queda con la ficha cuyo malId coincide. null si no aparece ahí.
async function findSlugByMalId(malId) {
	for (const entry of await getRecentlyUpdatedEpisodes()) {
		if ((await getMalIdBySlug(entry.slug)) === Number(malId)) return entry.slug;
	}
	return null;
}

// Igual que ENTRY_RE pero para las tarjetas del catálogo/buscador (/media/<slug>, sin episodio).
const SEARCH_ENTRY_RE = /href="\/media\/([a-z0-9-]+)"><span class="sr-only">Ver ([^<]+)<\/span>/g;

// El catálogo no expone los animes por malId, así que para resolver el slug de un anime que todavía
// no vimos pasar por "Recientemente Actualizado" usamos el buscador del sitio (?search=<título>) y
// nos quedamos con el resultado cuyo título normalizado coincide con el buscado. Preferimos no
// encontrar nada a devolver el slug de otro anime parecido.
async function findSlugByTitle(title) {
	const res = await av1Fetch(`https://animeav1.com/catalogo?search=${encodeURIComponent(title)}`);
	if (!res.ok) return null;
	const html = await res.text();

	const target = normalizeTitle(title);
	SEARCH_ENTRY_RE.lastIndex = 0;
	let match;
	const porPrefijo = [];
	while ((match = SEARCH_ENTRY_RE.exec(html))) {
		const candidato = normalizeTitle(match[2]);
		if (candidato === target) return match[1];
		// Nuestro título suele venir de MAL, recortado, sin el subtítulo largo que usa animeav1 (ej.
		// "Kyouran Reijou Nia Liston" vs "Kyouran Reijou Nia Liston: Byoujaku Reijou ni Tensei..."):
		// si el buscado es prefijo exacto por palabra del candidato, lo aceptamos como segunda opción,
		// pero solo si es el único - con dos o más preferimos no adivinar cuál es.
		if (candidato.startsWith(`${target} `)) porPrefijo.push(match[1]);
	}
	return porPrefijo.length === 1 ? porPrefijo[0] : null;
}

function uniqByUrl(items) {
	const seen = new Set();
	const out = [];
	for (const it of items) {
		if (!it?.url) continue;
		if (seen.has(it.url)) continue;
		seen.add(it.url);
		out.push(it);
	}
	return out;
}

// Desde un rediseño (Next.js), los links de descarga ya no están en <a href> del HTML: vienen
// embebidos como JSON dentro de un <script>, en un bloque con forma
// downloads:{SUB:[{server:"Mega",url:"..."},{server:"MP4Upload",url:"..."}],DUB:[...]} — pero DUB y
// SUB no siempre vienen en ese orden (bug real detectado: en algunos episodios es
// downloads:{DUB:[...],SUB:[...]}, con DUB primero). Por eso esto es en DOS pasos: primero aísla el
// objeto "downloads" entero (tolera un nivel de llaves anidadas, que es lo que tiene en la práctica),
// después busca "SUB:[...]" DENTRO de ese objeto nada más. Buscar "SUB:[...]" directo en toda la
// página (sin aislar antes "downloads") matchea la SUB equivocada: la página tiene otro bloque de
// reproductores en streaming (HLS/UPNShare/Voe/Byse) que también usa la forma SUB:[{server:...}] y
// aparece antes en el HTML.
const DOWNLOADS_BLOCK_RE = /downloads:\{((?:[^{}]|\{[^{}]*\})*)\}/s;
const DOWNLOADS_SUB_RE = /SUB:\[((?:\{[^{}]*\},?)*)\]/s;
const DOWNLOAD_ENTRY_RE = /\{server:"([^"]+)",url:"([^"]+)"\}/g;

// Fallback por si alguna página todavía sirve el formato viejo (<a href="..."><span>SUB</span></a>),
// para no perder cobertura de golpe si el sitio migra de a poco.
const LEGACY_LINKS_RE = /<a[^>]*href="([^"]+)"[^>]*>\s*([\s\S]*?)<\/a>/gi;

function legacyProviderFor(href) {
	const lower = href.toLowerCase();
	if (lower.includes('mega.nz') || lower.includes('mega.co.nz')) return 'Mega';
	if (lower.includes('mp4upload.com')) return 'MP4Upload';
	if (lower.includes('1fichier.com')) return '1Fichier';
	return null;
}

// Intenta extraer links de descarga del episodio desde la página del episodio. Como animeav1 no
// documenta estructura estable (y ya cambió de formato una vez), primero prueba el JSON embebido y,
// si no encuentra nada, cae al parseo viejo de <a href>.
async function getDownloadLinks(slug, episode) {
	const url = `https://animeav1.com/media/${slug}/${episode}`;
	const res = await av1Fetch(url);
	if (!res.ok) throw new Error(`animeav1 episodio respondió ${res.status}`);
	const html = await res.text();

	const links = [];

	const downloadsBlock = DOWNLOADS_BLOCK_RE.exec(html)?.[1];
	const subBlock = downloadsBlock ? DOWNLOADS_SUB_RE.exec(downloadsBlock)?.[1] : null;
	if (subBlock) {
		let m;
		DOWNLOAD_ENTRY_RE.lastIndex = 0;
		while ((m = DOWNLOAD_ENTRY_RE.exec(subBlock))) {
			links.push({ provider: m[1], url: m[2] });
		}
	}

	if (links.length === 0) {
		let m;
		LEGACY_LINKS_RE.lastIndex = 0;
		while ((m = LEGACY_LINKS_RE.exec(html))) {
			const provider = legacyProviderFor(m[1]);
			if (!provider) continue;
			if (!/\bSUB\b/i.test(m[2] ?? '')) continue;
			links.push({ provider, url: m[1].startsWith('http') ? m[1] : `https://animeav1.com${m[1]}` });
		}
	}

	// Limpiamos duplicados y agrupamos por proveedor, conservando el orden.
	const dedup = uniqByUrl(links);
	const byProvider = new Map();
	for (const it of dedup) {
		if (!byProvider.has(it.provider)) byProvider.set(it.provider, []);
		byProvider.get(it.provider).push(it.url);
	}

	return {
		pageUrl: url,
		providers: byProvider,
	};
}


module.exports = { getRecentlyUpdatedEpisodes, normalizeTitle, getCoverImage, getDownloadLinks, findSlugByTitle, getMediaId, getMalIdBySlug, findSlugByMalId };
