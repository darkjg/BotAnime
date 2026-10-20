const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

// Pi-hole resuelve por unbound (5335, recursivo, en claro) o por dnscrypt-proxy (5053, cifrado hacia Quad9/Cloudflare).
// El interruptor de la Homepage solo cambia el upstream de Pi-hole; dnscrypt-proxy queda siempre arrancado.
const CIFRADO = '127.0.0.1#5053';
const DIRECTO = '127.0.0.1#5335';

const ftl = (...args) => execFileAsync('sudo', ['-n', 'pihole-FTL', ...args], { timeout: 15_000, encoding: 'utf8' });

async function isDnsEncrypted() {
	const { stdout } = await ftl('--config', 'dns.upstreams');
	return stdout.includes(CIFRADO);
}

async function setDnsEncrypted(on) {
	if (on) {
		// Si el proxy no está, Pi-hole se quedaría sin DNS: mejor negarse.
		await execFileAsync('systemctl', ['is-active', '--quiet', 'dnscrypt-proxy.socket'], { timeout: 10_000 }).catch(() => {
			throw new Error('dnscrypt-proxy no está activo en la Pi');
		});
	}
	await ftl('--config', 'dns.upstreams', JSON.stringify([on ? CIFRADO : DIRECTO]));
	return on;
}

module.exports = { isDnsEncrypted, setDnsEncrypted };
