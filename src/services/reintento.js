// Google Sheets limita las lecturas por minuto y por usuario (60): al pasarse responde 429 "Quota exceeded".
// El límite se renueva cada minuto, así que esperar y volver a intentar casi siempre alcanza.
const ESPERAS_CUOTA_MS = [20_000, 40_000, 60_000];

function esErrorDeCuota(err) {
	if (!err) return false;
	if (err.code === 429 || err.status === 429 || err.response?.status === 429) return true;
	return /quota exceeded|rate limit exceeded|RESOURCE_EXHAUSTED|too many requests/i.test(String(err.message ?? ''));
}

const dormirReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ejecuta `tarea`; si falla por cuota espera y la repite, hasta esperas.length veces. Cualquier otro error
// se propaga enseguida (no tiene sentido reintentar un fallo que no es de cuota). La tarea tiene que ser
// repetible sin efectos dobles.
async function conReintentoDeCuota(tarea, { esperas = ESPERAS_CUOTA_MS, dormir = dormirReal, aviso = console.warn } = {}) {
	for (let intento = 0; ; intento++) {
		try {
			return await tarea();
		} catch (err) {
			if (!esErrorDeCuota(err) || intento >= esperas.length) throw err;
			aviso(`[sheets] Google limitó las consultas: reintento ${intento + 1}/${esperas.length} en ${esperas[intento] / 1000}s`);
			await dormir(esperas[intento]);
		}
	}
}

module.exports = { ESPERAS_CUOTA_MS, esErrorDeCuota, conReintentoDeCuota };
