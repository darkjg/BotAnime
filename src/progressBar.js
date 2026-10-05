// Barra de progreso de texto para mensajes de Discord: "▓▓▓▓░░░░ 50% · 26/52 · quedan ~9 min".
function barra(hecho, total, ancho = 20) {
	const fraccion = total > 0 ? Math.min(1, Math.max(0, hecho / total)) : 1;
	const llenos = Math.round(fraccion * ancho);
	return `${'\u2593'.repeat(llenos)}${'\u2591'.repeat(ancho - llenos)} ${Math.round(fraccion * 100)}%`;
}

function duracion(segundos) {
	if (segundos < 60) return `${Math.max(1, Math.round(segundos))} s`;
	const minutos = Math.ceil(segundos / 60);
	return `${minutos} min`;
}

// segundosPorPaso: lo que tarda cada paso que falta (para estimar el tiempo restante).
function textoProgreso({ titulo, hecho, total, fase = null, segundosPorPaso = 0 }) {
	const restante = segundosPorPaso > 0 && hecho < total ? ` \u00b7 quedan ~${duracion((total - hecho) * segundosPorPaso)}` : '';
	const detalle = fase ? `\n${fase}` : '';
	return `${titulo}\n${barra(hecho, total)} \u00b7 ${hecho}/${total}${restante}${detalle}`;
}

module.exports = { barra, duracion, textoProgreso };
