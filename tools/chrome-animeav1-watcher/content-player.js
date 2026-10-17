// Corre DENTRO del iframe del reproductor (HLS/zilla-networks, UPNShare, Voe, Byse o MP4Upload -
// los 5 servidores que ofrece animeav1 para el SUB). Al ser un dominio distinto al de animeav1.com,
// solo puede hacer esto porque el content script se inyecta directamente en ese frame (mismo origen
// que el propio iframe) - un script de la página padre no podría tocar este <video> por CORS.
//
// Si el servidor en cuestión no usa un <video> real (p.ej. un reproductor con canvas/overlays
// propios) esto simplemente no encuentra nada y no hace nada - confirmado en vivo que al menos el
// servidor HLS (zilla-networks, el que carga por defecto) sí usa un <video> HTML5 normal (JWPlayer).

const UMBRAL_VISTO = 0.90; // mismo umbral que tools/vlc-watcher (VlcWatcher/Program.cs)

function vigilarVideo(video) {
	console.log('[animeav1-watcher] <video> encontrado en', location.hostname, '- vigilando progreso');
	let marcado = false;
	let ultimoIntento = 0;

	async function revisar() {
		if (marcado || !video.duration) return;
		if (video.currentTime / video.duration < UMBRAL_VISTO) return;

		// No reintentar en cada "timeupdate" (dispara varias veces por segundo) mientras el bot no
		// confirme - de lo contrario se le manda un mensaje al background sin parar hasta el final
		// del vídeo.
		const ahora = Date.now();
		if (ahora - ultimoIntento < 5000) return;
		ultimoIntento = ahora;

		console.log('[animeav1-watcher] umbral alcanzado, avisando al background...');
		const respuesta = await chrome.runtime.sendMessage({ tipo: 'episodio-visto' }).catch((err) => {
			console.warn('[animeav1-watcher] no pude avisar al background:', err);
			return null;
		});
		console.log('[animeav1-watcher] respuesta del background:', respuesta);
		if (respuesta?.ok) marcado = true;
	}

	video.addEventListener('timeupdate', revisar);
	video.addEventListener('ended', revisar);
}

// El <video> no siempre existe todavía cuando se inyecta este script (el reproductor tarda un poco
// en montarse) - se espera a que aparezca en vez de asumir que ya está ahí.
function esperarVideo() {
	const existente = document.querySelector('video');
	if (existente) {
		vigilarVideo(existente);
		return;
	}
	const observer = new MutationObserver(() => {
		const video = document.querySelector('video');
		if (video) {
			observer.disconnect();
			vigilarVideo(video);
		}
	});
	observer.observe(document.documentElement, { childList: true, subtree: true });
}

esperarVideo();
