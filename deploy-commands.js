require('dotenv').config();
const { REST, Routes } = require('discord.js');
const temporadaForo = require('./src/commands/temporadaForo');
const temporadaReparar = require('./src/commands/temporadaReparar');
const temporadaReconstruir = require('./src/commands/temporadaReconstruir');
const avisos = require('./src/commands/avisos');
const votoRol = require('./src/commands/votoRol');
const capitulo = require('./src/commands/capitulo');
const recargaCaps = require('./src/commands/recargaCaps');
const enComun = require('./src/commands/enComun');
const pendientes = require('./src/commands/pendientes');
const refrescarHilos = require('./src/commands/refrescarHilos');
const linkFix = require('./src/commands/linkFix');
const apodo = require('./src/commands/apodo');
const apodosImportar = require('./src/commands/apodosImportar');
const respaldoAnimeav1 = require('./src/commands/respaldoAnimeav1');
const horarioGrebe = require('./src/commands/horarioGrebe');
const vacaciones = require('./src/commands/vacaciones');
const recordatorio = require('./src/commands/recordatorio');
const quedada = require('./src/commands/quedada');
const yumi = require('./src/commands/yumi');
const quitarUsuario = require('./src/commands/quitarUsuario');
const limpiarNombreHoja = require('./src/commands/limpiarNombreHoja');

const commands = [
	temporadaForo.data.toJSON(),
	temporadaReparar.data.toJSON(),
	temporadaReconstruir.data.toJSON(),
	avisos.data.toJSON(),
	votoRol.data.toJSON(),
	capitulo.data.toJSON(),
	recargaCaps.data.toJSON(),
	enComun.data.toJSON(),
	pendientes.data.toJSON(),
	refrescarHilos.data.toJSON(),
	linkFix.data.toJSON(),
	apodo.data.toJSON(),
	apodosImportar.data.toJSON(),
	respaldoAnimeav1.data.toJSON(),
	horarioGrebe.data.toJSON(),
	vacaciones.data.toJSON(),
	recordatorio.data.toJSON(),
	quedada.data.toJSON(),
	yumi.data.toJSON(),
	quitarUsuario.data.toJSON(),
	limpiarNombreHoja.data.toJSON(),
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

	// Los comandos de servidor no aparecen en el MD con el bot: los que tienen que andar ahí van como
	// globales. Se registran con POST (crea o pisa solo ese nombre, no toca otros globales) y se sacan de
	// la lista de servidor para que no aparezcan duplicados.
	const globalCommands = [respaldoAnimeav1.data.toJSON()];
	const guildCommands = commands.filter((c) => !globalCommands.some((g) => g.name === c.name));

	for (const guildId of guildIds) {
		const data = await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), { body: guildCommands });
		console.log(`Comandos registrados en guild ${guildId}: ${data.length}`);
	}
	for (const command of globalCommands) {
		await rest.post(Routes.applicationCommands(process.env.CLIENT_ID), { body: command });
		console.log(`Comando global registrado: /${command.name}`);
	}
})();
