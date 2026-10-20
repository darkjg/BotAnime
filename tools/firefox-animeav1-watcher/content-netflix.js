// Corre en www.netflix.com. Netflix es una SPA: pasar al siguiente capítulo cambia la URL
// (/watch/<id>) sin recargar, así que todo se hace por sondeo de 1s en vez de por eventos.
// A diferencia de animeav1 aquí no hay id de anime: se avisa al bot por título + capítulo, y él lo
// cruza con los animes que sigues (mismo camino que Erai-raws).

const UMBRAL_VISTO = 0.90; // mismo umbral que el resto de vigilantes

// shortcut: los textos de Netflix ("Temporada 2: Ep. 3", "T2:E3", "Season 2: Episode 3") se parsean
// con regex para es/en; otro idioma de la interfaz no se reconoce, ampliar aquí si hace falta.
const TEMPORADA_RE = /\b(?:Temporada|Season|T|S)\s*(\d+)/i;
const EPISODIO_RE = /\b(?:Episodio|Episode|Ep\.?|E)\s*(\d+)/i;

let urlActual = location.pathname;
let info = null; // { title, episode }
let textoPrevio = null; // texto del título del capítulo anterior, para no leerlo "rancio" tras navegar
let textoLeido = null;
let marcado = false;
let ultimoIntento = 0;

// El bloque de título solo existe en el DOM mientras los controles están visibles.
function leerInfo() {
	const bloque = document.querySelector('[data-uia="video-title"]');
	if (!bloque) return;
	const texto = bloque.innerText.trim();
	if (!texto || texto === textoPrevio) return;

	const titulo = (bloque.querySelector('h4')?.innerText ?? texto.split('\n')[0]).trim();
	const detalle = texto.slice(texto.indexOf(titulo) + titulo.length);
	const episodio = Number(EPISODIO_RE.exec(detalle)?.[1]);
	if (!titulo || !Number.isFinite(episodio) || !episodio) return;

	// Netflix mete las secuelas como "Temporada N" de la misma serie, el bot las tiene como
	// "<Título> N" (ej. "Cyberpunk: Edgerunners 2").
	const temporada = Number(TEMPORADA_RE.exec(detalle)?.[1]);
	info = { title: temporada > 1 ? `${titulo} ${temporada}` : titulo, episode: episodio };
	textoLeido = texto;
	console.log('[netflix-watcher] detectado', info);
}

async function revisar() {
	if (location.pathname !== urlActual) {
		urlActual = location.pathname;
		textoPrevio = textoLeido;
		info = null;
		marcado = false;
	}
	if (!location.pathname.startsWith('/watch/') || marcado) return;
	if (!info) leerInfo();
	const video = document.querySelector('video');
	if (!info || !video?.duration || video.currentTime / video.duration < UMBRAL_VISTO) return;

	const ahora = Date.now();
	if (ahora - ultimoIntento < 5000) return;
	ultimoIntento = ahora;

	const respuesta = await browser.runtime.sendMessage({ tipo: 'netflix-visto', ...info }).catch((err) => {
		console.warn('[netflix-watcher] no pude avisar al background:', err);
		return null;
	});
	if (respuesta?.ok) marcado = true;
}

setInterval(revisar, 1000);
