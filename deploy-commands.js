require('dotenv').config();
const { REST, Routes } = require('discord.js');
const temporada = require('./src/commands/temporada');
const temporadaForo = require('./src/commands/temporadaForo');
const avisos = require('./src/commands/avisos');

const commands = [temporada.data.toJSON(), temporadaForo.data.toJSON(), avisos.data.toJSON()];

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
	const route = process.env.GUILD_ID
		? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
		: Routes.applicationCommands(process.env.CLIENT_ID);

	const data = await rest.put(route, { body: commands });
	console.log(`Comandos registrados: ${data.length}`);
})();
