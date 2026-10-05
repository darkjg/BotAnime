const { EmbedBuilder } = require('discord.js');
const { diaDesdeIso, diaAIso, fechaTexto, parseFecha } = require('./horarioGrebe');

// Todas las horas que escribe la gente son de Madrid; en la base se guarda el instante (ms epoch) y la
// fecha/hora de pared para poder repetir "los viernes a las 21:00" aunque cambie el horario de verano.
const ZONA = 'Europe/Madrid';
const HORA_MS = 3_600_000;
const MS_DIA = 86_400_000;
// Una quedada a más de esto probablemente es un año/mes mal escrito.
const MAX_DIAS_ADELANTE = 120;

const DIAS_SEMANA = { lunes: 0, martes: 1, miercoles: 2, jueves: 3, viernes: 4, sabado: 5, domingo: 6 };
const NOMBRES_DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

const mod = (n, m) => ((n % m) + m) % m;
const pad = (n) => String(n).padStart(2, '0');
const MARCAS_ACENTO = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g');
const sinAcentos = (texto) => texto.normalize('NFD').replace(MARCAS_ACENTO, '').toLowerCase().trim();

const formatoMadrid = new Intl.DateTimeFormat('en-US', {
	timeZone: ZONA,
	hourCycle: 'h23',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
});

function partesMadrid(epochMs) {
	const p = Object.fromEntries(formatoMadrid.formatToParts(new Date(epochMs)).map((x) => [x.type, Number(x.value)]));
	return { anio: p.year, mes: p.month, dia: p.day, hora: p.hour, min: p.minute, diaNumero: Math.floor(Date.UTC(p.year, p.month - 1, p.day) / MS_DIA) };
}

// Cuánto se adelanta la hora de pared de Madrid respecto a UTC en ese instante (1 h en invierno, 2 h en verano).
function desfaseMadrid(epochMs) {
	const p = partesMadrid(epochMs);
	return Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.min, 0) - Math.floor(epochMs / 60_000) * 60_000;
}

// El instante en que en Madrid son las hora:min de ese día. null si esa hora no existe (el día que se
// adelanta el reloj en primavera, por ejemplo 02:30).
function madridAEpoch(anio, mes, dia, hora, min) {
	const pared = Date.UTC(anio, mes - 1, dia, hora, min);
	let epoch = pared - desfaseMadrid(pared);
	epoch = pared - desfaseMadrid(epoch);
	return epoch + desfaseMadrid(epoch) === pared ? epoch : null;
}

const dowDeDia = (diaNumero) => mod(diaNumero + 3, 7); // 1970-01-01 fue jueves; lunes = 0

// El día y la hora de una quedada a partir de lo que escribió la persona.
//   textoDia: "hoy", "mañana", un día de la semana ("viernes") o una fecha (dd/mm, dd/mm/aaaa).
//   textoHora: "21", "21:30", "21.30", "21h", "21h30".
// Devuelve { fecha: 'YYYY-MM-DD', hora: 'HH:MM', startsAt } o { error: 'dia' | 'hora' | 'inexistente' | 'pasado' | 'lejos' }.
function resolverMomento(textoDia, textoHora, ahoraMs) {
	const h = /^(\d{1,2})(?:[:.h](\d{2}))?h?$/.exec(sinAcentos(textoHora));
	if (!h) return { error: 'hora' };
	const hora = Number(h[1]);
	const min = h[2] ? Number(h[2]) : 0;
	if (hora > 23 || min > 59) return { error: 'hora' };

	const hoy = partesMadrid(ahoraMs).diaNumero;
	const texto = sinAcentos(textoDia);
	let dia;
	let porNombre = false;
	if (texto === 'hoy') {
		dia = hoy;
	} else if (texto === 'manana') {
		dia = hoy + 1;
	} else if (texto in DIAS_SEMANA) {
		dia = hoy + mod(DIAS_SEMANA[texto] - dowDeDia(hoy), 7);
		porNombre = true;
	} else {
		dia = parseFecha(textoDia, hoy);
		if (dia === null) return { error: 'dia' };
	}

	const instante = (numeroDia) => {
		const [anio, mes, d] = diaAIso(numeroDia).split('-').map(Number);
		return madridAEpoch(anio, mes, d, hora, min);
	};

	let startsAt = instante(dia);
	if (startsAt === null) return { error: 'inexistente' };
	// "el viernes" dicho un viernes por la noche, ya pasada la hora, es el de la semana que viene.
	if (porNombre && startsAt <= ahoraMs) {
		dia += 7;
		startsAt = instante(dia);
		if (startsAt === null) return { error: 'inexistente' };
	}
	if (startsAt <= ahoraMs) return { error: 'pasado' };
	if (startsAt - ahoraMs > MAX_DIAS_ADELANTE * MS_DIA) return { error: 'lejos' };
	return { fecha: diaAIso(dia), hora: `${pad(hora)}:${pad(min)}`, startsAt };
}

// La misma fecha y hora una semana después (la hora de pared no cambia aunque cambie el horario).
function ocurrenciaSemanaSiguiente(fecha, hora) {
	const iso = diaAIso(diaDesdeIso(fecha) + 7);
	const [anio, mes, dia] = iso.split('-').map(Number);
	const [h, m] = hora.split(':').map(Number);
	// Si esa hora no existe (salto de primavera) se usa la de invierno; es un caso raro y de un solo día.
	const startsAt = madridAEpoch(anio, mes, dia, h, m) ?? Date.UTC(anio, mes - 1, dia, h, m) - HORA_MS;
	return { fecha: iso, startsAt };
}

const momentoTexto = (fecha, hora) => `${fechaTexto(diaDesdeIso(fecha))} a las ${hora}`;

// Sugerencias para el campo "día": hoy, mañana y los próximos 7 días con su fecha.
function sugerenciasDia(ahoraMs) {
	const hoy = partesMadrid(ahoraMs).diaNumero;
	const lista = [
		{ valor: 'hoy', etiqueta: `hoy · ${fechaTexto(hoy)}` },
		{ valor: 'mañana', etiqueta: `mañana · ${fechaTexto(hoy + 1)}` },
	];
	for (let i = 2; i < 9; i++) lista.push({ valor: NOMBRES_DIAS[dowDeDia(hoy + i)], etiqueta: `${NOMBRES_DIAS[dowDeDia(hoy + i)]} · ${fechaTexto(hoy + i)}` });
	return lista;
}

const TIPOS = {
	nueva: { titulo: '📺 Nueva quedada', color: 0x2b6cb0 },
	hora: { titulo: '⏰ Falta 1 hora para la quedada', color: 0xf39c12 },
	ahora: { titulo: '🎬 ¡Empieza la quedada!', color: 0x2ecc71 },
	cancelada: { titulo: '❌ Quedada cancelada', color: 0xe74c3c },
};

// tipo: 'nueva' | 'hora' | 'ahora' | 'cancelada'. La mención va aparte (en el content del mensaje).
function armarAviso(tipo, quedada, { imageUrl } = {}) {
	const { titulo, color } = TIPOS[tipo];
	const lineas = [`**${quedada.title}**`];
	if (tipo === 'cancelada') lineas.push(`Era el ${momentoTexto(quedada.fecha, quedada.hora)}`);
	else lineas.push(`🗓️ ${momentoTexto(quedada.fecha, quedada.hora)} · <t:${Math.floor(quedada.startsAt / 1000)}:R>`);
	if (quedada.weekly && tipo !== 'cancelada') lineas.push('🔁 Se repite cada semana');
	if (quedada.note) lineas.push(`📝 ${quedada.note}`);
	lineas.push(`Organiza <@${quedada.createdBy}>`);

	const embed = new EmbedBuilder().setTitle(titulo).setDescription(lineas.join('\n')).setColor(color);
	if (imageUrl) embed.setThumbnail(imageUrl);
	if (tipo === 'nueva') embed.setFooter({ text: 'Aviso 1 hora antes y a la hora exacta a todos los que ven este anime' });
	return embed;
}

// Los votantes del anime y quien la organiza, sin repetir.
function menciones(votantes, creadorId) {
	return [...new Set([...votantes, creadorId])].map((id) => `<@${id}>`).join(' ');
}

module.exports = {
	HORA_MS,
	MAX_DIAS_ADELANTE,
	partesMadrid,
	madridAEpoch,
	resolverMomento,
	ocurrenciaSemanaSiguiente,
	momentoTexto,
	sugerenciasDia,
	armarAviso,
	menciones,
};
