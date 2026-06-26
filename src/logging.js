// Le agrega fecha y hora a console.log/console.error en todo el proyecto. Se importa una sola vez,
// al principio de Bot.js, antes de que cualquier otro módulo loguee algo.
function timestamp() {
	const now = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);

console.log = (...args) => originalLog(`[${timestamp()}]`, ...args);
console.error = (...args) => originalError(`[${timestamp()}]`, ...args);
