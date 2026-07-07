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
	const res = await fetch(HOME_URL);
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

// Normaliza títulos (sin acentos/puntuación, en minúscula) para cruzar el nombre que usa animeav1
// contra el título que guardamos de MAL sin exigir que coincidan carácter por carácter.
function normalizeTitle(title) {
	return title
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

// En la ficha de cada anime (/media/<slug>) la portada es el único <img> con la clase
// "aspect-poster"; el resto de <img> de la página son logos, backdrop, recomendaciones o capturas.
const COVER_RE = /<img class="aspect-poster[^"]*"[^>]*src="([^"]+)"/;

// Devuelve la URL de la portada de un anime a partir de su slug, o null si la ficha no existe
// o cambió de estructura.
async function getCoverImage(slug) {
	const res = await fetch(`https://animeav1.com/media/${slug}`);
	if (!res.ok) return null;
	const html = await res.text();
	const match = html.match(COVER_RE);
	return match?.[1] ?? null;
}

// Igual que ENTRY_RE pero para las tarjetas del catálogo/buscador (/media/<slug>, sin episodio).
const SEARCH_ENTRY_RE = /href="\/media\/([a-z0-9-]+)"><span class="sr-only">Ver ([^<]+)<\/span>/g;

// El catálogo no expone los animes por malId, así que para resolver el slug de un anime que todavía
// no vimos pasar por "Recientemente Actualizado" usamos el buscador del sitio (?search=<título>) y
// nos quedamos con el resultado cuyo título normalizado coincide EXACTO con el buscado. Preferimos
// no encontrar nada a devolver el slug de otro anime parecido.
async function findSlugByTitle(title) {
	const res = await fetch(`https://animeav1.com/catalogo?search=${encodeURIComponent(title)}`);
	if (!res.ok) return null;
	const html = await res.text();

	const target = normalizeTitle(title);
	SEARCH_ENTRY_RE.lastIndex = 0;
	let match;
	while ((match = SEARCH_ENTRY_RE.exec(html))) {
		if (normalizeTitle(match[2]) === target) return match[1];
	}
	return null;
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

// Intenta extraer links de descarga del episodio desde la página del episodio.
// Como animeav1 no documenta estructura estable, usamos regex por dominios y capturamos hrefs.
async function getDownloadLinks(slug, episode) {
	const url = `https://animeav1.com/media/${slug}/${episode}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`animeav1 episodio respondió ${res.status}`);
	const html = await res.text();

	// Extraemos todos los links de descarga por provider y luego filtramos SOLO los que tienen SUB.
	// El HTML del sitio no es 100% estable, así que evitamos depender de que el <span> esté
	// justo como en el ejemplo.

	//
	// Ejemplo observado en el source:
	// <a ... href="https://mega.nz/file/..."> ... <span ...>SUB</span> ...</a>
	const LINKS_RE = /<a[^>]*href="([^"]+)"[^>]*>\s*([\s\S]*?)<\/a>/gi;
	const links = [];
	let m;
	while ((m = LINKS_RE.exec(html))) {
		const href = m[1];
		const inner = m[2] ?? '';
		const lower = href.toLowerCase();

		let provider = null;
		if (lower.includes('mega.nz') || lower.includes('mega.co.nz')) provider = 'Mega';
		else if (lower.includes('mp4upload.com')) provider = 'MP4Upload';
		else if (lower.includes('1fichier.com')) provider = '1ficher';
		if (!provider) continue;

		// Filtra SUB vs DUB.
		if (!/\bSUB\b/i.test(inner)) continue;

		const abs = href.startsWith('http') ? href : `https://animeav1.com${href}`;
		links.push({ provider, url: abs });
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

module.exports = { getRecentlyUpdatedEpisodes, normalizeTitle, getCoverImage, getDownloadLinks, findSlugByTitle };

