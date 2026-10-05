// Horario rotativo de Grebe: 9 semanas que se repiten sin parar. Cada semana son 7 letras, de lunes a
// domingo: M = mañana, T = tarde, N = noche, - = libre (los colores de la hoja: azul, verde, negro).
const CICLO = ['-MMMMM-', 'MMMMM--', 'MMMMM--', 'TTTTT--', 'TTTTT--', 'NNNNN-N', 'NNNN---', '-NNNNN-', '-TTTTT-'];

// Semana de referencia para saber dónde cae el ciclo en el calendario: el lunes de una semana y qué
// número (1-9) del ciclo es. Como el ciclo se repite cada 9 semanas, sirve cualquiera.
const REFERENCIA = { lunes: '2026-09-14', semana: 9 };

// emoji = celda normal (cuadrado); hoy = la misma celda iluminada (círculo) para el día consultado.
const TURNOS = {
	M: { nombre: 'mañana', emoji: '🟦', hoy: '🔵', color: 0x0000ff },
	T: { nombre: 'tarde', emoji: '🟩', hoy: '🟢', color: 0x00c800 },
	N: { nombre: 'noche', emoji: '⬛', hoy: '⚫', color: 0x1e1f22 },
};
const LIBRE = { nombre: 'libre', emoji: '⬜', hoy: '⚪', color: 0x99aab5 };
// Los días de vacaciones (/vacaciones) pisan lo que le tocaría por el ciclo.
const VACACIONES = { nombre: 'vacaciones', emoji: '🟨', hoy: '🟡', color: 0xf1c40f };

// Tope de un periodo de vacaciones: evita que un año mal escrito cargue meses por error.
const MAX_VACACIONES_DIAS = 100;

const DIAS_CORTO = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const MS_DIA = 86_400_000;
const mod = (n, m) => ((n % m) + m) % m;

// Un día es un número entero (días desde 1970-01-01 en UTC): así no hay líos de zona horaria ni de
// cambio de hora al sumar/restar días.
function diaNumero(anio, mes, dia) {
	return Math.floor(Date.UTC(anio, mes - 1, dia) / MS_DIA);
}

function diaDesdeIso(iso) {
	const [anio, mes, dia] = iso.split('-').map(Number);
	return diaNumero(anio, mes, dia);
}

function diaAIso(dia) {
	return new Date(dia * MS_DIA).toISOString().slice(0, 10);
}

const anioDe = (dia) => new Date(dia * MS_DIA).getUTCFullYear();

function hoyEnMadrid() {
	return diaDesdeIso(new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' }));
}

const lunesSemana1 = diaDesdeIso(REFERENCIA.lunes) - (REFERENCIA.semana - 1) * 7;

// { semana: 1-9, dow: 0 (lunes) - 6 (domingo), turno: { nombre, emoji, color }, libra } según el ciclo.
function turnoDelDia(dia) {
	const desde = dia - lunesSemana1;
	const semana = mod(Math.floor(desde / 7), CICLO.length);
	const dow = mod(desde, 7);
	const turno = TURNOS[CICLO[semana][dow]];
	return { dia, semana: semana + 1, dow, turno: turno ?? LIBRE, libra: !turno };
}

// Las vacaciones son [{ desde, hasta }] con días (números) y ambas puntas incluidas.
function vacacionesDesdeFilas(filas) {
	return filas.map((fila) => ({ id: fila.id, desde: diaDesdeIso(fila.desde), hasta: diaDesdeIso(fila.hasta) }));
}

// Igual que turnoDelDia pero con las vacaciones encima: si ese día cae en un periodo, `turno` pasa a ser
// VACACIONES y `vacaciones` trae el periodo (`libra` sigue diciendo si el ciclo lo dejaba libre).
function estadoDelDia(dia, vacaciones = []) {
	const info = turnoDelDia(dia);
	const periodo = vacaciones.find((v) => dia >= v.desde && dia <= v.hasta) ?? null;
	return periodo ? { ...info, turno: VACACIONES, vacaciones: periodo } : { ...info, vacaciones: null };
}

// Primer día con turno a partir de `dia` (sin contarlo), saltándose los libres y las vacaciones.
function proximoTurno(dia, vacaciones = []) {
	for (let siguiente = dia + 1; siguiente <= dia + 400; siguiente++) {
		const info = estadoDelDia(siguiente, vacaciones);
		if (!info.vacaciones && !info.libra) return info;
	}
	return null;
}

// Periodos que todavía no terminaron a `hoy` (en curso o futuros), del más próximo al más lejano.
function vacacionesVigentes(hoy, vacaciones) {
	return vacaciones.filter((v) => v.hasta >= hoy).sort((a, b) => a.desde - b.desde);
}

function fechaTexto(dia) {
	const fecha = new Date(dia * MS_DIA);
	return `${DIAS_CORTO[mod(fecha.getUTCDay() + 6, 7)]} ${fecha.getUTCDate()} ${MESES[fecha.getUTCMonth()]}`;
}

const fechaLarga = (dia) => `${fechaTexto(dia)} ${anioDe(dia)}`;

function rangoTexto(desde, hasta) {
	return `${fechaLarga(desde)} – ${fechaLarga(hasta)}`;
}

// dd/mm o dd/mm/aaaa (separadores / . -) -> { d, m, a } (a = null si no hay año), o null si no tiene ese formato.
function partesFecha(texto) {
	const partes = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}))?$/.exec(texto.trim());
	if (!partes) return null;
	return { d: Number(partes[1]), m: Number(partes[2]), a: partes[3] ? Number(partes[3]) : null };
}

// El día si (anio, mes, dia) existe en el calendario; null si no (31/02, 29/02 de un año no bisiesto...).
function diaSiExiste(anio, mes, dia) {
	const numero = diaNumero(anio, mes, dia);
	const fecha = new Date(numero * MS_DIA);
	if (fecha.getUTCFullYear() !== anio || fecha.getUTCMonth() + 1 !== mes || fecha.getUTCDate() !== dia) return null;
	return numero;
}

// Sin año se usa el de `hoy`. null si no es una fecha real.
function parseFecha(texto, hoy) {
	const partes = partesFecha(texto);
	if (!partes) return null;
	return diaSiExiste(partes.a ?? anioDe(hoy), partes.m, partes.d);
}

// Las dos fechas de un periodo de vacaciones. Sin año, "desde" es la próxima vez que llega esa fecha (si
// ya pasó este año, el que viene) y "hasta" es la primera vez que llega después de "desde". Devuelve
// { desde, hasta } o { error: 'formato' | 'fecha' | 'orden' | 'largo' }.
function resolverRango(textoDesde, textoHasta, hoy) {
	const pd = partesFecha(textoDesde);
	const ph = partesFecha(textoHasta);
	if (!pd || !ph) return { error: 'formato' };

	let desde = diaSiExiste(pd.a ?? anioDe(hoy), pd.m, pd.d);
	if (desde !== null && pd.a === null && desde < hoy) desde = diaSiExiste(anioDe(hoy) + 1, pd.m, pd.d);
	if (desde === null) return { error: 'fecha' };

	let hasta = diaSiExiste(ph.a ?? anioDe(desde), ph.m, ph.d);
	if (hasta !== null && ph.a === null && hasta < desde) hasta = diaSiExiste(anioDe(desde) + 1, ph.m, ph.d);
	if (hasta === null) return { error: 'fecha' };

	if (hasta < desde) return { error: 'orden' };
	if (hasta - desde + 1 > MAX_VACACIONES_DIAS) return { error: 'largo' };
	return { desde, hasta };
}

// Los 7 días de la semana que contiene `dia`, de lunes a domingo, con las vacaciones aplicadas.
function semanaDe(dia, vacaciones = []) {
	const lunes = dia - turnoDelDia(dia).dow;
	return Array.from({ length: 7 }, (_, i) => estadoDelDia(lunes + i, vacaciones));
}

const keycap = (n) => `${n}${String.fromCharCode(0xfe0f, 0x20e3)}`;

// L M X J V S D como letras de emoji (símbolos de indicador regional). Van separadas por un espacio de
// ancho cero para que Discord no junte pares como M+X o S+D en una bandera.
const INICIALES_DIAS = [0x1f1f1, 0x1f1f2, 0x1f1fd, 0x1f1ef, 0x1f1fb, 0x1f1f8, 0x1f1e9].map((c) => String.fromCodePoint(c));
const ANCHO_CERO = String.fromCharCode(0x200b);

// El ciclo entero como tabla de emojis: una fila por semana del ciclo, una columna por día (lunes a domingo).
// Discord no dibuja tablas ni alinea texto con emojis: por eso TODO es emoji (mismo ancho) — el número de
// semana es un keycap y la cabecera son letras de emoji. La celda de `semanaActual`/`dowActual` sale como
// círculo, y la fila de esa semana empieza con 👉 (en vez de su número; el número va en el título del
// campo) y termina con la `marca`. Es la plantilla del ciclo: no refleja las vacaciones.
function tablaCiclo(semanaActual, dowActual, marca) {
	const cabecera = ['📅', ...INICIALES_DIAS].join(ANCHO_CERO);
	const filas = CICLO.map((semana, s) => {
		const esActual = s + 1 === semanaActual;
		const celdas = [...semana]
			.map((letra, dow) => {
				const turno = TURNOS[letra] ?? LIBRE;
				return esActual && dow === dowActual ? turno.hoy : turno.emoji;
			})
			.join('');
		return `${esActual ? '👉' : keycap(s + 1)}${celdas}${esActual ? ` ◀ ${marca}` : ''}`;
	});
	return [cabecera, ...filas].join('\n');
}

module.exports = {
	CICLO,
	TURNOS,
	LIBRE,
	VACACIONES,
	MAX_VACACIONES_DIAS,
	turnoDelDia,
	estadoDelDia,
	proximoTurno,
	vacacionesDesdeFilas,
	vacacionesVigentes,
	fechaTexto,
	fechaLarga,
	rangoTexto,
	parseFecha,
	resolverRango,
	semanaDe,
	tablaCiclo,
	hoyEnMadrid,
	diaDesdeIso,
	diaAIso,
};
