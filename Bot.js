require('dotenv').config();
require('./src/logging');
const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
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
const reaccion = require('./src/commands/reaccion');
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

const { handleInteraction } = require('./src/interactions');
const { startAv1EpisodeNotifier } = require('./src/scheduler');
const { startQuedadasNotifier } = require('./src/quedadasService');
const { startRemindersNotifier } = require('./src/remindersService');
const { handleMessage: handleLinkFixMessage, handleReactionAdd: handleLinkFixReaction } = require('./src/linkFixService');
const { conServidor } = require('./src/services/sheetTarget');

// GuildMessages + MessageContent hacen falta para leer el texto de los mensajes (link de twitter/x a
// arreglar); MessageContent es un intent privilegiado, hay que habilitarlo en el Developer Portal del
// bot (Bot > Message Content Intent) o el login falla. GuildMessageReactions es para la reacción 🗑️
// que deshace el reemplazo. Los partials son necesarios porque esa reacción puede llegar sobre un
// mensaje que el cliente no tiene en caché (recién reiniciado el bot, por ejemplo).
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildMessageReactions,
	],
	partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.commands = new Collection();
client.commands.set(temporadaForo.data.name, temporadaForo);
client.commands.set(temporadaReparar.data.name, temporadaReparar);
client.commands.set(temporadaReconstruir.data.name, temporadaReconstruir);
client.commands.set(avisos.data.name, avisos);
client.commands.set(votoRol.data.name, votoRol);
client.commands.set(capitulo.data.name, capitulo);
client.commands.set(recargaCaps.data.name, recargaCaps);
client.commands.set(enComun.data.name, enComun);
client.commands.set(pendientes.data.name, pendientes);
client.commands.set(refrescarHilos.data.name, refrescarHilos);
client.commands.set(linkFix.data.name, linkFix);
client.commands.set(reaccion.data.name, reaccion);
client.commands.set(apodo.data.name, apodo);
client.commands.set(apodosImportar.data.name, apodosImportar);
client.commands.set(respaldoAnimeav1.data.name, respaldoAnimeav1);
client.commands.set(horarioGrebe.data.name, horarioGrebe);
client.commands.set(vacaciones.data.name, vacaciones);
client.commands.set(recordatorio.data.name, recordatorio);
client.commands.set(quedada.data.name, quedada);
client.commands.set(yumi.data.name, yumi);
client.commands.set(quitarUsuario.data.name, quitarUsuario);
client.commands.set(limpiarNombreHoja.data.name, limpiarNombreHoja);



// Si el login se cuelga (ej. arranque en frío del Pi con el reloj todavía sin sincronizar por NTP:
// las validaciones TLS fallan hasta que se sincroniza) el proceso queda "vivo" pero nunca conectado, y
// pm2 no lo reinicia solo porque no reinicia procesos que siguen corriendo, solo los que mueren. Este
// watchdog fuerza la salida si no conectó a tiempo, para que pm2 lo levante de nuevo y reintente.
const LOGIN_TIMEOUT_MS = 60_000;
const loginWatchdog = setTimeout(() => {
	console.error(`[bot] no me conecté a Discord en ${LOGIN_TIMEOUT_MS / 1000}s, reinicio el proceso`);
	process.exit(1);
}, LOGIN_TIMEOUT_MS);

// Heartbeat para Uptime Kuma: mientras el bot esté conectado y respondiendo, le avisa cada rato. Si el
// proceso se cuelga o se cae, deja de llegar y Kuma lo marca caído solo.
const KUMA_PUSH_URL = 'http://192.168.1.100:3002/api/push/60e65c6c98da9cca6418100b22a46f8e?status=up&msg=OK&ping=';
const KUMA_PUSH_INTERVAL_MS = 60_000;
function pushKumaHeartbeat() {
	fetch(KUMA_PUSH_URL).catch((err) => console.error('[bot] heartbeat a Uptime Kuma falló:', err.message));
}

client.once('clientReady', () => {
	clearTimeout(loginWatchdog);
	console.log(`Conectado como ${client.user.tag}`);
	startAv1EpisodeNotifier(client);
	startQuedadasNotifier(client);
	startRemindersNotifier(client);
	pushKumaHeartbeat();
	setInterval(pushKumaHeartbeat, KUMA_PUSH_INTERVAL_MS);
});

client.on('messageCreate', (message) => {
	handleLinkFixMessage(message).catch((err) => console.error('[bot] error en linkFix:', err.message));
});

client.on('messageReactionAdd', async (reaction, user) => {
	try {
		if (reaction.partial) await reaction.fetch();
		await handleLinkFixReaction(reaction, user);
	} catch (err) {
		console.error('[bot] error en la reacción de linkFix:', err.message);
	}
});

client.on('interactionCreate', async (interaction) => {
	try {
		if (interaction.isChatInputCommand()) {
			console.log(`[bot] /${interaction.commandName} usado por ${interaction.user.tag} en guild ${interaction.guildId}`);
			const command = client.commands.get(interaction.commandName);
			if (!command) return;
			await conServidor(interaction.guildId, () => command.execute(interaction));
			return;
		}

		if (interaction.isAutocomplete()) {
			const command = client.commands.get(interaction.commandName);
			if (command?.autocomplete) await command.autocomplete(interaction);
			return;
		}

		await conServidor(interaction.guildId, () => handleInteraction(interaction));
	} catch (error) {
		console.error('[bot] error procesando interacción:', error);
		const errorMessage = 'Ocurrió un error al procesar la interacción.';
		if (interaction.deferred || interaction.replied) {
			await interaction.editReply(errorMessage).catch(() => {});
		} else {
			await interaction.reply({ content: errorMessage, ephemeral: true }).catch(() => {});
		}
	}
});

client.login(process.env.DISCORD_TOKEN).catch((err) => {
	console.error('[bot] client.login falló:', err.message);
	process.exit(1);
});
