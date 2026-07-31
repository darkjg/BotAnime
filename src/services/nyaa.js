const { normalizeTitle } = require('./animeav1');

// c=1_2 es la categoría "Anime - English-translated" (la única donde publica Erai-raws). Antes usaba
// el mirror nyaa.one, pero empezó a servir el feed con <nyaa:infoHash> vacío para todos los items
// (detectado 2026-07-30: sin hash no se puede armar el magnet, así que findEraiMagnet nunca
// encontraba nada aunque el título/episodio matcheara bien). nyaa.si es el sitio original y sigue
// sirviendo el hash correctamente.
const RSS_URL = 'https://nyaa.si/?page=rss&f=0&c=1_2';

// Trackers estándar que usa nyaa.si/nyaa.one en sus propios magnets; el feed no trae el link del
// magnet armado, así que se arma acá a partir del infoHash.
const TRACKERS = [
	'http://nyaa.tracker.wf:7777/announce',
	'udp://open.stealth.si:80/announce',
	'udp://tracker.opentrackr.org:1337/announce',
	'udp://exodus.desync.com:6969/announce',
	'udp://tracker.torrent.eu.org:451/announce',
];

function buildMagnet(hash, title) {
	const trackers = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
	return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${trackers}`;
}

function decodeEntities(str) {
	return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function parseRssItems(xml) {
	const items = [];
	for (const block of xml.split('<item>').slice(1)) {
		const title = /<title>([^<]*)<\/title>/.exec(block)?.[1];
		const hash = /<nyaa:infoHash>([^<]*)<\/nyaa:infoHash>/.exec(block)?.[1];
		if (!title || !hash) continue;
		items.push({ title: decodeEntities(title), hash });
	}
	return items;
}

// "[Erai-raws] <título> - <episodio>[ (CA)][ [...]" — el sufijo "(CA)" aparece en releases corregidos.
const ERAI_TITLE_RE = /^\[erai-raws\]\s*(.+?)\s*-\s*(\d+)(?:\s*\([^)]*\))?\s*\[/i;

// Busca en nyaa.si el release de Erai-raws en 1080p WEB (WEBRip o WEB-DL) para un episodio puntual, y
// arma su magnet a partir del infoHash. Devuelve null si no hay ninguno que matchee título+episodio.
// No filtra por fuente (CR/AMZN/NF/etc.): antes exigía "CR WEB" y con eso se perdían animes que Erai
// solo saca de Amazon/Netflix/otras plataformas en vez de Crunchyroll (detectado 2026-07-30 con
// "Katainaka no Ossan, Kensei ni Naru II", que solo tiene release AMZN WEB-DL).
async function findEraiMagnet(animeTitle, episode) {
	const res = await fetch(`${RSS_URL}&q=${encodeURIComponent(`erai-raws ${animeTitle}`)}`);
	if (!res.ok) throw new Error(`nyaa.si respondió ${res.status}`);
	const xml = await res.text();
	const items = parseRssItems(xml);

	const targetTitle = normalizeTitle(animeTitle);
	const targetEpisode = String(episode).padStart(2, '0');

	for (const item of items) {
		if (!/1080p/i.test(item.title) || !/web/i.test(item.title)) continue;

		const match = ERAI_TITLE_RE.exec(item.title);
		if (!match) continue;
		const [, releaseTitle, releaseEpisode] = match;
		if (releaseEpisode.padStart(2, '0') !== targetEpisode) continue;
		if (normalizeTitle(releaseTitle) !== targetTitle) continue;

		return { title: item.title, magnet: buildMagnet(item.hash, item.title) };
	}
	return null;
}

module.exports = { findEraiMagnet };
