require('dotenv').config();
const { REST, Routes } = require('discord.js');
const temporadaForo = require('./src/commands/temporadaForo');
const temporadaReparar = require('./src/commands/temporadaReparar');
const temporadaReconstruir = require('./src/commands/temporadaReconstruir');
const avisos = require('./src/commands/avisos');
const votoRol = require('./src/commands/votoRol');
const capitulo = require('./src/commands/capitulo');
const recargaCaps = require('./src/commands/recargaCaps');

const commands = [
	temporadaForo.data.toJSON(),
	temporadaReparar.data.toJSON(),
	temporadaReconstruir.data.toJSON(),
	avisos.data.toJSON(),
	votoRol.data.toJSON(),
	capitulo.data.toJSON(),
	recargaCaps.data.toJSON(),
];

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

// GUILD_ID es el servidor de producción; TEST_GUILD_ID (opcional) es un servidor aparte para probar

// sin afectarlo. Si no hay ninguno de los dos, se registran como comandos globales.
const guildIds = [process.env.GUILD_ID, process.env.TEST_GUILD_ID].filter(Boolean);

(async () => {
	if (guildIds.length === 0) {
		const data = await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
		console.log(`Comandos globales registrados: ${data.length}`);
		return;
	}

	for (const guildId of guildIds) {
		const data = await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), { body: commands });
		console.log(`Comandos registrados en guild ${guildId}: ${data.length}`);
	}
})();
