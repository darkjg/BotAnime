// Duraciones tipo "1hora", "30min", "2dias", "1h30m", "1 dia y 2 horas"... Se acepta cualquier
// combinación de número+unidad (con o sin espacios entre medio), y se suman todas. Si sobra algo del
// texto que no se reconoce como número+unidad ni como separador (espacio, coma, "y"), se rechaza entero
// en vez de ignorarlo en silencio: mejor un error claro que un recordatorio a una hora que no es la que
// la persona tenía en mente.
const UNIDADES_MS = {
	s: 1000, seg: 1000, segundo: 1000, segundos: 1000,
	m: 60_000, min: 60_000, minuto: 60_000, minutos: 60_000,
	h: 3_600_000, hora: 3_600_000, horas: 3_600_000,
	d: 86_400_000, dia: 86_400_000, dias: 86_400_000,
	sem: 604_800_000, semana: 604_800_000, semanas: 604_800_000,
};

const MIN_MS = 30 * 1000; // menos que esto no da tiempo a nada útil, probablemente es un error de tipeo
const MAX_MS = 90 * 86_400_000; // 90 días: un límite generoso para no acumular recordatorios olvidados para siempre
// Un recordatorio que se repite no puede ir más rápido que esto: a diferencia de uno normal (que avisa
// una sola vez), repetido cada pocos segundos sería spam continuo en el canal hasta que alguien lo cancele.
const MIN_REPETICION_MS = 10 * 60 * 1000;

function normalizarUnidad(u) {
	return u
		.toLowerCase()
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, ''); // "días" -> "dias", sin tocar el resto de letras
}

// Devuelve la duración en ms, o null si el texto no se puede interpretar (formato inválido).
function parseDuracion(texto) {
	const limpio = String(texto ?? '').trim();
	if (!limpio) return null;

	const re = /(\d+)\s*([a-zA-Záéíóúñ]+)/g;
	let match;
	let totalMs = 0;
	let restante = limpio;
	let huboAlguna = false;

	while ((match = re.exec(limpio))) {
		const unidad = normalizarUnidad(match[2]);
		const ms = UNIDADES_MS[unidad];
		if (ms == null) return null;
		totalMs += Number(match[1]) * ms;
		restante = restante.replace(match[0], '');
		huboAlguna = true;
	}
	if (!huboAlguna) return null;

	// Lo que queda tras sacar las partes reconocidas debería ser solo separadores; cualquier otra cosa
	// (una unidad que no existe, texto suelto) invalida todo el resultado.
	if (restante.replace(/[\s,]+|\by\b/gi, '').length > 0) return null;

	return totalMs;
}

// Inversa de parseDuracion, para mostrarla: 5_400_000 -> "1 h 30 min", 172_800_000 -> "2 días".
function formatearDuracion(ms) {
	const partes = [];
	let resto = Math.round(ms / 1000);
	for (const [nombre, segundos] of [['día', 86_400], ['h', 3_600], ['min', 60], ['s', 1]]) {
		const cantidad = Math.floor(resto / segundos);
		if (cantidad === 0) continue;
		partes.push(nombre === 'día' ? `${cantidad} ${cantidad === 1 ? 'día' : 'días'}` : `${cantidad} ${nombre}`);
		resto -= cantidad * segundos;
	}
	return partes.join(' ') || '0 s';
}

// Primera ocurrencia de un recordatorio repetido que cae ESTRICTAMENTE después de `ahora`, manteniendo
// el ritmo original (dueAt + n·cada). Si el bot estuvo caído y se perdieron varias ocurrencias, se saltan
// en vez de mandarlas todas de golpe al volver: se avisa una vez y se sigue desde la siguiente futura.
function proximaOcurrencia(dueAt, cadaMs, ahora) {
	return dueAt + (Math.floor((ahora - dueAt) / cadaMs) + 1) * cadaMs;
}

module.exports = { parseDuracion, formatearDuracion, proximaOcurrencia, MIN_MS, MAX_MS, MIN_REPETICION_MS, UNIDADES_MS };
