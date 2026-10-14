const { SlashCommandBuilder } = require('discord.js');
const { getOrCreateWatchToken, regenerateWatchToken, getAvisoPrivadoPreference, setAvisoPrivadoPreference } = require('../services/db');
const { autoCleanupReply } = require('../ephemeral');

// Token personal para el vigilante de VLC (programa aparte que corre en el PC de cada uno, ver
// watchServer.js) — con esto el bot sabe quién sos sin que tengas que loguearte con Discord desde el
// programa. Autoservicio: cualquiera lo pide para sí mismo, no hace falta que un admin se lo dé.
const data = new SlashCommandBuilder()
	.setName('vlc-watcher-token')
	.setDescription('Pide tu token personal para el vigilante de VLC (para que avise solo cuando ves un capítulo)')
	.addBooleanOption((o) => o.setName('regenerar').setDescription('Invalida tu token anterior y te da uno nuevo').setRequired(false))
	.addBooleanOption((o) =>
		o
			.setName('aviso-privado')
			.setDescription('Si marcás un capítulo sin estar en un canal de voz, ¿te avisa por privado en vez de en el canal?')
			.setRequired(false),
	);

async function execute(interaction) {
	const regenerar = interaction.options.getBoolean('regenerar') ?? false;
	const avisoPrivado = interaction.options.getBoolean('aviso-privado');
	const token = regenerar ? regenerateWatchToken(interaction.user.id) : getOrCreateWatchToken(interaction.user.id);
	if (avisoPrivado !== null) setAvisoPrivadoPreference({ discordId: interaction.user.id, avisoPrivado });

	const privadoActual = avisoPrivado ?? getAvisoPrivadoPreference(interaction.user.id);
	await interaction.reply({
		content:
			`Tu token personal (no lo compartas, sirve para marcar capítulos como tuyos):\n` +
			`\`\`\`${token}\`\`\`\n` +
			`Pégalo la primera vez que abras el vigilante de VLC en tu PC — se queda guardado ahí, no hace falta volver a escribirlo.` +
			(regenerar ? '\n\n⚠️ Tu token anterior ya no funciona.' : '') +
			(avisoPrivado !== null ? `\n\n${privadoActual ? '🔒 A partir de ahora' : '📢 A partir de ahora NO'} te aviso por privado cuando marques un capítulo sin estar en voz.` : '') +
			(avisoPrivado === null ? `\n\nAviso cuando marcás sin estar en voz: ${privadoActual ? '**por privado**' : '**en el canal**'} (cambialo con \`aviso-privado\`).` : ''),
		ephemeral: true,
	});
	autoCleanupReply(interaction, 5 * 60 * 1000); // 5 min: tiempo de sobra para copiarlo antes de que se borre
}

module.exports = { data, execute };
