// Junta lo que sabe content-page.js (qué anime/capítulo se está viendo, leído de animeav1.com) con
// lo que avisa content-player.js (que el vídeo llegó al final, leído desde el iframe de otro
// dominio) y avisa al mismo endpoint que usa el vigilante de VLC (tools/vlc-watcher).

const BOT_URL = 'https://newjg.chickenkiller.com/vlc-watched';

const episodioPorPestana = new Map(); // tabId -> { mediaId, episodio }
const yaAvisado = new Set(); // "mediaId:episodio" ya confirmado por el bot, para no repetir

browser.runtime.onMessage.addListener((mensaje, sender) => {
	const tabId = sender.tab?.id;
	console.log('[animeav1-watcher] mensaje recibido:', mensaje, 'tabId:', tabId);
	if (tabId == null) return;

	if (mensaje.tipo === 'episodio-actual') {
		episodioPorPestana.set(tabId, { mediaId: mensaje.mediaId, episodio: mensaje.episodio });
		return;
	}

	if (mensaje.tipo === 'episodio-visto') {
		const actual = episodioPorPestana.get(tabId);
		if (!actual) {
			console.warn('[animeav1-watcher] el reproductor avisó pero no sé qué episodio es esta pestaña (no llegó "episodio-actual")');
			return Promise.resolve({ ok: false });
		}
		return avisarBot(actual.mediaId, actual.episodio);
	}
});

browser.tabs.onRemoved.addListener((tabId) => episodioPorPestana.delete(tabId));

// Igual que el vigilante de VLC (ver Program.cs/AvisarBot): si el bot respondió (lo haya marcado o
// no) no tiene sentido reintentar - esa respuesta no va a cambiar. Solo un fallo de red/timeout deja
// la puerta abierta a que content-player.js lo vuelva a intentar más tarde.
async function avisarBot(mediaId, episodio) {
	const clave = `${mediaId}:${episodio}`;
	if (yaAvisado.has(clave)) return { ok: true };

	const { token } = await browser.storage.local.get('token');
	if (!token) {
		console.warn('[animeav1-watcher] falta el token - configúralo desde el icono de la extensión');
		return { ok: false };
	}

	try {
		const respuesta = await fetch(BOT_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token, av1MediaId: mediaId, episode: episodio }),
		});
		const cuerpo = await respuesta.json().catch(() => null);
		if (!cuerpo) {
			console.warn(`[animeav1-watcher] respuesta rara del bot (HTTP ${respuesta.status})`);
			return { ok: false };
		}
		yaAvisado.add(clave);
		if (cuerpo.ok) {
			console.log(`[animeav1-watcher] marcado: ${cuerpo.titulo} cap. ${cuerpo.episode} -> ${(cuerpo.marcados ?? []).join(', ')}`);
		} else {
			console.warn('[animeav1-watcher] el bot no pudo marcarlo:', cuerpo.error);
		}
		return { ok: true };
	} catch (err) {
		console.warn('[animeav1-watcher] no pude avisar al bot, se reintentará:', err);
		return { ok: false };
	}
}
