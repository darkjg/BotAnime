const { SlashCommandBuilder } = require('discord.js');
const { addYumiGame, undoLastYumiGame, getYumiStats } = require('../services/db');

// Anotar/deshacer es solo del dueño (comprobado en execute, no con permisos de servidor: cualquier admin
// podría tocarlo si fuera por permisos); "ver conteo" lo puede usar cualquiera.
const OWNER_ID = process.env.OWNER_ID ?? '203106964572471296';

const data = new SlashCommandBuilder()
	.setName('yumi')
	.setDescription('Conteo de partidas de Yumi de pegu: perdidas vs ganadas (anotar: solo el dueño)')
	.addStringOption((option) =>
		option
			.setName('accion')
			.setDescription('Qué anotar')
			.setRequired(true)
			.addChoices(
				{ name: 'Perdimos una partida', value: 'perdida' },
				{ name: 'Ganamos una partida', value: 'ganada' },
				{ name: 'Ver conteo', value: 'ver' },
				{ name: 'Deshacer la última anotada', value: 'deshacer' },
			),
	);

function marcador({ losses, wins }) {
	return `Yumi de pegu — **Perdidas ${losses}** vs **Ganadas ${wins}**`;
}

async function execute(interaction) {
	const accion = interaction.options.getString('accion', true);

	if (accion === 'ver') {
		await interaction.reply(marcador(getYumiStats()));
		return;
	}

	if (interaction.user.id !== OWNER_ID) {
		await interaction.reply({ content: 'Anotar o deshacer partidas es solo para el dueño del bot (ver el conteo sí puede cualquiera).', ephemeral: true });
		return;
	}

	if (accion === 'perdida' || accion === 'ganada') {
		addYumiGame({ won: accion === 'ganada' });
		await interaction.reply(`${accion === 'perdida' ? '💀 Otra derrota anotada.' : '🏆 Victoria anotada.'}\n${marcador(getYumiStats())}`);
		return;
	}

	if (accion === 'deshacer') {
		const undone = undoLastYumiGame();
		if (!undone) {
			await interaction.reply({ content: 'No hay ninguna partida anotada para deshacer.', ephemeral: true });
			return;
		}
		await interaction.reply(`↩️ Quité la última (era una ${undone.won ? 'victoria' : 'derrota'}).\n${marcador(getYumiStats())}`);
		return;
	}

}

module.exports = { data, execute };
