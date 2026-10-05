const { AsyncLocalStorage } = require('node:async_hooks');

// Qué hoja de Google usa cada servidor. El servidor de pruebas (TEST_GUILD_ID) escribe SOLO en TEST_SHEET_ID
// y, si esa variable no está, falla en vez de caer en la hoja real: así una prueba nunca toca producción.
// Cualquier otro servidor (y todo lo que corre sin servidor, como los scripts) usa SHEET_ID.
const almacen = new AsyncLocalStorage();

function hojaDeServidor(guildId, env = process.env) {
	if (guildId && env.TEST_GUILD_ID && String(guildId) === String(env.TEST_GUILD_ID)) {
		if (!env.TEST_SHEET_ID) {
			throw new Error('El servidor de pruebas necesita TEST_SHEET_ID en el .env (no uso la hoja real para pruebas).');
		}
		return env.TEST_SHEET_ID;
	}
	return env.SHEET_ID;
}

// Ejecuta fn (y todo lo asíncrono que lance) apuntando a la hoja de ese servidor.
function conServidor(guildId, fn) {
	return almacen.run({ spreadsheetId: hojaDeServidor(guildId) }, fn);
}

// Igual pero con una hoja ya resuelta (lo usa la cola de sheets.js para conservar el contexto).
function conHoja(spreadsheetId, fn) {
	return almacen.run({ spreadsheetId }, fn);
}

function hojaActual() {
	return almacen.getStore()?.spreadsheetId ?? process.env.SHEET_ID;
}

module.exports = { hojaDeServidor, conServidor, conHoja, hojaActual };
