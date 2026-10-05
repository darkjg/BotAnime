const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { listVacacionesGrebe } = require('../services/db');
const {
	estadoDelDia,
	proximoTurno,
	fechaTexto,
	rangoTexto,
	parseFecha,
	semanaDe,
	tablaCiclo,
	vacacionesDesdeFilas,
	vacacionesVigentes,
	hoyEnMadrid,
} = require('../horarioGrebe');
const { autoCleanupReply } = require('../ephemeral');

// El nombre no puede llevar mayúsculas (Discord las rechaza en los comandos), por eso no es "horarioGrebe".
const data = new SlashCommandBuilder()
	.setName('horario-grebe')
	.setDescription('Qué turno tiene Grebe (mañana, tarde, noche, libre o de vacaciones)')
	.addStringOption((option) =>
		option.setName('fecha').setDescription('Día a consultar: dd/mm o dd/mm/aaaa (por defecto, hoy)').setRequired(false),
	);

function armarEmbed(dia, hoy, vacaciones) {
	const info = estadoDelDia(dia, vacaciones);
	const cuando = dia === hoy ? 'Hoy' : fechaTexto(dia);

	let descripcion;
	if (info.vacaciones) {
		descripcion = `**${cuando}** Grebe está de **vacaciones** ${info.turno.emoji} (hasta el **${fechaTexto(info.vacaciones.hasta)}**)`;
		const vuelve = proximoTurno(info.vacaciones.hasta, vacaciones);
		if (vuelve) descripcion += `\nVuelve a trabajar el **${fechaTexto(vuelve.dia)}**, de ${vuelve.turno.nombre} ${vuelve.turno.emoji}`;
	} else if (info.libra) {
		descripcion = `**${cuando}** Grebe **libra** ${info.turno.emoji}`;
		const proximo = proximoTurno(dia, vacaciones);
		if (proximo) descripcion += `\nVuelve el **${fechaTexto(proximo.dia)}**, de ${proximo.turno.nombre} ${proximo.turno.emoji}`;
	} else {
		descripcion = `**${cuando}** Grebe trabaja de **${info.turno.nombre}** ${info.turno.emoji}`;
	}

	const semana = semanaDe(dia, vacaciones);
	const lineas = semana.map((d) => {
		const marca = d.dia === dia ? ' ◀' : '';
		return `${d.turno.emoji} **${fechaTexto(d.dia)}** · ${d.turno.nombre}${marca}`;
	});

	const campos = [
		{
			// El ciclo es la plantilla: un día de vacaciones sigue mostrando ahí el turno que le tocaría.
			name: info.vacaciones ? 'Ciclo de 9 semanas (el turno que le tocaría)' : 'Ciclo de 9 semanas',
			value: tablaCiclo(info.semana, info.dow, dia === hoy ? 'hoy' : fechaTexto(dia)),
		},
		{ name: `Semana ${info.semana} de 9 · ${fechaTexto(semana[0].dia)} – ${fechaTexto(semana[6].dia)}`, value: lineas.join('\n') },
	];

	const proximasVacaciones = vacacionesVigentes(hoy, vacaciones).slice(0, 5);
	if (proximasVacaciones.length > 0) {
		campos.push({ name: 'Vacaciones', value: proximasVacaciones.map((v) => `🟨 ${rangoTexto(v.desde, v.hasta)}`).join('\n') });
	}

	return new EmbedBuilder()
		.setTitle('📅 Horario de Grebe')
		.setDescription(descripcion)
		.setColor(info.turno.color)
		.addFields(...campos)
		.setFooter({ text: '🟦 mañana  🟩 tarde  ⬛ noche  ⬜ libre  🟨 vacaciones  ·  el círculo es el día consultado' });
}

// El horario siempre se publica en este canal, se use el comando desde donde se use.
const CANAL_HORARIO_ID = '796675019589550141';

async function mandarAlCanal(client, embed) {
	const canal = await client.channels.fetch(CANAL_HORARIO_ID);
	if (!canal?.isTextBased()) throw new Error('el canal no existe o no es de texto');
	await canal.send({ embeds: [embed] });
}

async function execute(interaction) {
	const hoy = hoyEnMadrid();
	const texto = interaction.options.getString('fecha');
	const dia = texto ? parseFecha(texto, hoy) : hoy;

	if (dia === null) {
		await interaction.reply({ content: 'No entendí esa fecha. Usá dd/mm o dd/mm/aaaa, por ejemplo 25/09.', ephemeral: true });
		autoCleanupReply(interaction);
		return;
	}

	const embed = armarEmbed(dia, hoy, vacacionesDesdeFilas(listVacacionesGrebe()));

	// Ya está en ese canal: se responde ahí mismo, sin mandar un mensaje aparte.
	if (interaction.channelId === CANAL_HORARIO_ID) {
		await interaction.reply({ embeds: [embed] });
		return;
	}

	await interaction.deferReply({ ephemeral: true });
	try {
		await mandarAlCanal(interaction.client, embed);
		await interaction.editReply(`Listo, mandé el horario a <#${CANAL_HORARIO_ID}>.`);
		autoCleanupReply(interaction);
	} catch (err) {
		// Sin acceso al canal (permisos) o ya no existe: el horario no se pierde, se lo da solo a quien lo pidió.
		console.error('[horarioGrebe] no pude mandar el horario al canal:', err.message);
		await interaction.editReply({ content: `No pude mandarlo a <#${CANAL_HORARIO_ID}> (${err.message}). Te lo dejo acá:`, embeds: [embed] });
	}
}

module.exports = { data, execute, armarEmbed };
