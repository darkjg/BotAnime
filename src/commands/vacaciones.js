const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { listVacacionesGrebe, saveVacacionGrebe, deleteVacacionGrebe } = require('../services/db');
const {
	MAX_VACACIONES_DIAS,
	resolverRango,
	vacacionesDesdeFilas,
	vacacionesVigentes,
	rangoTexto,
	hoyEnMadrid,
	diaAIso,
} = require('../horarioGrebe');
const { autoCleanupReply } = require('../ephemeral');

// Sin setDefaultMemberPermissions abierto a todos, cualquiera podría cambiar las vacaciones de Grebe: por
// defecto solo quien gestiona el servidor. Un admin puede darle acceso a otros roles/personas desde
// Ajustes del servidor > Integraciones, sin tocar el código.
const data = new SlashCommandBuilder()
	.setName('vacaciones')
	.setDescription('Vacaciones de Grebe (se ven en /horario-grebe)')
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
	.addSubcommand((sub) =>
		sub
			.setName('agregar')
			.setDescription('Indica que Grebe tiene vacaciones de un día a otro')
			.addStringOption((o) => o.setName('desde').setDescription('Primer día de vacaciones: dd/mm o dd/mm/aaaa').setRequired(true))
			.addStringOption((o) => o.setName('hasta').setDescription('Último día de vacaciones (incluido): dd/mm o dd/mm/aaaa').setRequired(true)),
	)
	.addSubcommand((sub) =>
		sub
			.setName('quitar')
			.setDescription('Quita un periodo de vacaciones')
			.addStringOption((o) => o.setName('periodo').setDescription('Periodo que quieres quitar').setRequired(true).setAutocomplete(true)),
	)
	.addSubcommand((sub) => sub.setName('listar').setDescription('Muestra las vacaciones guardadas'));

const ERRORES = {
	formato: 'No entendí las fechas. Usá dd/mm o dd/mm/aaaa, por ejemplo `05/10` y `18/10`.',
	fecha: 'Una de las fechas no existe en el calendario (¿31/02?). Revisala.',
	orden: 'La fecha final es anterior a la inicial.',
	largo: `Son más de ${MAX_VACACIONES_DIAS} días seguidos; revisá las fechas (si es correcto, cargalo en dos partes).`,
};

const dias = (v) => v.hasta - v.desde + 1;
const diasTexto = (v) => `${dias(v)} ${dias(v) === 1 ? 'día' : 'días'}`;

// Los avisos de error solo le sirven a quien se equivocó: privados y se borran solos.
async function responder(interaction, content) {
	await interaction.reply({ content, ephemeral: true });
	autoCleanupReply(interaction);
}

// Lo que cambia (o consulta) las vacaciones se publica en el canal para que lo vea el grupo, y se queda.
async function anunciar(interaction, content) {
	await interaction.reply({ content });
}

async function agregar(interaction) {
	const hoy = hoyEnMadrid();
	const rango = resolverRango(interaction.options.getString('desde', true), interaction.options.getString('hasta', true), hoy);
	if (rango.error) {
		await responder(interaction, ERRORES[rango.error]);
		return;
	}

	const guardado = saveVacacionGrebe({ desde: diaAIso(rango.desde), hasta: diaAIso(rango.hasta), creadoPor: interaction.user.id });
	const [periodo] = vacacionesDesdeFilas([guardado]);
	let mensaje = `✅ Vacaciones de Grebe guardadas: **${rangoTexto(rango.desde, rango.hasta)}** (${diasTexto(rango)}).`;
	if (guardado.unidas > 0) {
		mensaje += `\nSe unieron con ${guardado.unidas === 1 ? 'otro periodo' : `${guardado.unidas} periodos`} que se tocaban: ahora son **${rangoTexto(periodo.desde, periodo.hasta)}**.`;
	}
	mensaje += '\nYa se ven en `/horario-grebe`.';
	await anunciar(interaction, mensaje);
}

async function quitar(interaction) {
	const id = Number(interaction.options.getString('periodo', true));
	const periodo = vacacionesDesdeFilas(listVacacionesGrebe()).find((v) => v.id === id);
	if (!periodo || !deleteVacacionGrebe(id)) {
		await responder(interaction, 'No encontré ese periodo (¿ya lo quitaron?). Elegí uno de la lista que aparece al escribir.');
		return;
	}
	await anunciar(interaction, `🗑️ Quité las vacaciones **${rangoTexto(periodo.desde, periodo.hasta)}**.`);
}

async function listar(interaction) {
	const hoy = hoyEnMadrid();
	const todas = vacacionesDesdeFilas(listVacacionesGrebe());
	const vigentes = vacacionesVigentes(hoy, todas);
	const pasadas = todas.length - vigentes.length;

	if (vigentes.length === 0) {
		await anunciar(interaction, `No hay vacaciones guardadas${pasadas > 0 ? ` (solo ${pasadas} ya terminada${pasadas === 1 ? '' : 's'})` : ''}.`);
		return;
	}
	const lineas = vigentes.map((v) => `${v.desde <= hoy ? '🏖️ **en curso**' : '🟨'} ${rangoTexto(v.desde, v.hasta)} (${diasTexto(v)})`);
	if (pasadas > 0) lineas.push(`_${pasadas} periodo${pasadas === 1 ? '' : 's'} ya terminado${pasadas === 1 ? '' : 's'} no se muestra${pasadas === 1 ? '' : 'n'}._`);
	await anunciar(interaction, `**Vacaciones de Grebe**\n${lineas.join('\n')}`);
}

async function execute(interaction) {
	const sub = interaction.options.getSubcommand();
	if (sub === 'agregar') return agregar(interaction);
	if (sub === 'quitar') return quitar(interaction);
	return listar(interaction);
}

// Al escribir en "periodo" ofrece los guardados: primero los vigentes (del más próximo al más lejano) y
// después los ya terminados (el más reciente primero). Discord admite hasta 25 opciones.
async function autocomplete(interaction) {
	const hoy = hoyEnMadrid();
	const todas = vacacionesDesdeFilas(listVacacionesGrebe());
	const vigentes = vacacionesVigentes(hoy, todas);
	const pasadas = todas.filter((v) => v.hasta < hoy).sort((a, b) => b.desde - a.desde);
	const buscado = interaction.options.getFocused().toLowerCase();

	const opciones = [...vigentes, ...pasadas]
		.map((v) => ({ name: `${rangoTexto(v.desde, v.hasta)} (${diasTexto(v)})${v.hasta < hoy ? ' · terminado' : ''}`, value: String(v.id) }))
		.filter((o) => o.name.toLowerCase().includes(buscado))
		.slice(0, 25);
	await interaction.respond(opciones);
}

module.exports = { data, execute, autocomplete };
