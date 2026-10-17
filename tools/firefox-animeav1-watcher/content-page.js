// Corre en la página del episodio (https://animeav1.com/media/<slug>/<episodio>). El reproductor
// vive en un iframe de otro dominio (ver content-player.js) que no tiene forma de saber por sí solo
// qué anime/capítulo es - eso solo está aquí, en la página de animeav1. Por eso este script le pasa
// esa info al background, que es quien la junta con el aviso de "visto" que llega desde el iframe.

// El id interno de animeav1 (no el slug) viene embebido en el HTML de la ficha, igual que lo lee
// src/services/animeav1.js en el bot (getMediaId) - mismo formato, misma fuente.
const MEDIA_ID_RE = /media:\{id:(\d+),categoryId:\d+,title:"/;

function episodioDesdeUrl() {
	const partes = location.pathname.split('/').filter(Boolean); // ["media", "<slug>", "<episodio>"]
	const episodio = Number(partes[2]);
	return Number.isFinite(episodio) ? episodio : null;
}

function avisarEpisodioActual() {
	const match = MEDIA_ID_RE.exec(document.documentElement.innerHTML);
	const mediaId = match ? Number(match[1]) : null;
	const episodio = episodioDesdeUrl();
	if (mediaId && episodio) {
		console.log(`[animeav1-watcher] detectado mediaId=${mediaId} episodio=${episodio}`);
		browser.runtime.sendMessage({ tipo: 'episodio-actual', mediaId, episodio });
	} else {
		console.warn(`[animeav1-watcher] no pude leer mediaId/episodio de esta página (mediaId=${mediaId}, episodio=${episodio})`);
	}
}

avisarEpisodioActual();

// El sitio navega entre "Anterior"/"Siguiente" episodio sin recargar la página (client-side) - sin
// esto, el background seguiría creyendo que estás en el capítulo con el que abriste la pestaña.
// Se comprueba la URL por intervalo en vez de depender de un evento que el sitio no dispara.
let ultimaUrl = location.href;
setInterval(() => {
	if (location.href !== ultimaUrl) {
		ultimaUrl = location.href;
		avisarEpisodioActual();
	}
}, 1000);
