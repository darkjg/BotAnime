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

module.exports = { getRecentlyUpdatedEpisodes, normalizeTitle, getCoverImage };
