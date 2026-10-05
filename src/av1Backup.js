const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getBotState, setBotState, listPendingNotices, getNotifyWindow } = require('./services/db');
const { isBackupMode, setBackupMode, isWarpEnabled, enableWarp, disableWarp } = require('./services/av1Net');

const PROMPT_KEY = 'av1WarpPromptAt';
const DECLINED_KEY = 'av1WarpDeclinedAt';
// Un solo chequeo fallido puede ser un tropiezo de red; el bloqueo por partidos dura horas.
const FAILS_BEFORE_PROMPT = 2;
const PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DECLINED_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
// El MD automático solo sirve si llega a tiempo para que, aceptando, se aprovechen los últimos chequeos de
// la ventana de avisos: como muy tarde 15 min antes de los 2 últimos. Pasado ese límite no se manda hasta el
// día siguiente.
const LAST_CHECKS_COUNT = 2;
const DEADLINE_MARGIN_MIN = 15;

let consecutiveFailures = 0;
let ownerId = null;

async function getOwnerId(client) {
	if (!ownerId) {
		const app = await client.application.fetch();
		ownerId = app.owner?.ownerId ?? app.owner?.id ?? null;
	}
	return ownerId;
}

function buildPromptRow(active, warpOn) {
	const yes = (customId, label) => new ButtonBuilder().setCustomId(customId).setLabel(label).setEmoji('✅').setStyle(ButtonStyle.Success);
	const no = (label) => new ButtonBuilder().setCustomId('av1warp:no').setLabel(label).setEmoji('❌').setStyle(ButtonStyle.Danger);

	if (!active) return new ActionRowBuilder().addComponents(yes('av1warp:on', 'Activar WARP'), no('No hacer nada'));
	if (warpOn) return new ActionRowBuilder().addComponents(yes('av1warp:off', 'Desactivar'), no('Dejarlo activo'));
	// Respaldo activo pero sin WARP en uso (no estaba instalado, o falló): se puede reintentar conectarlo.
	return new ActionRowBuilder().addComponents(
		yes('av1warp:on', 'Conectar WARP'),
		new ButtonBuilder().setCustomId('av1warp:off').setLabel('Desactivar todo').setEmoji('🛑').setStyle(ButtonStyle.Secondary),
		no('Dejarlo así'),
	);
}

// Texto y botones de la pregunta. manual = lo pidió él con /respaldo-animeav1.
function buildPromptMessage({ manual }) {
	const active = isBackupMode();
	const warpOn = isWarpEnabled();
	let content;
	if (active) {
		const pending = listPendingNotices().length;
		content =
			`🛰️ **Modo respaldo de animeav1: activo**\n` +
			`• WARP: ${warpOn ? 'conectado' : 'no está en uso'}\n` +
			`• Avisos guardados esperando la ventana: ${pending}\n\n` +
			(warpOn ? '¿Lo desactivo?' : '¿Intento conectar WARP?');
	} else {
		const motivo = manual
			? '🛰️ **Modo respaldo de animeav1**'
			: '⚠️ **No puedo leer animeav1.com desde hace un rato** (a esta hora suele ser el bloqueo de LaLiga por los partidos).';
		content =
			`${motivo}\n\n¿Lo activo?\n` +
			'• Conecto **Cloudflare WARP** solo para las lecturas del bot; el resto de la Pi no cambia.\n' +
			'• En cada chequeo guardo los episodios nuevos con sus links, y cuando llegue la ventana de avisos los mando desde lo guardado, aunque animeav1 esté bloqueado en ese momento.';
	}
	return { content, components: [buildPromptRow(active, warpOn)] };
}

// Le manda el MD con la pregunta al dueño del bot.
async function sendBackupPrompt(client, { manual }) {
	const id = await getOwnerId(client);
	if (!id) throw new Error('no pude determinar quién es el dueño del bot');
	const user = await client.users.fetch(id);
	await user.send(buildPromptMessage({ manual }));
}

async function handleAv1WarpButton(interaction, action) {
	if (interaction.user.id !== (await getOwnerId(interaction.client))) {
		await interaction.reply({ content: 'Solo el dueño del bot puede usar esto.', ephemeral: true });
		return;
	}

	if (action === 'no') {
		setBotState(DECLINED_KEY, Date.now());
		await interaction.update({ content: '❌ Listo, no cambio nada.', components: [] });
		return;
	}

	await interaction.deferUpdate();

	if (action === 'off') {
		setBackupMode(false);
		await disableWarp();
		await interaction.editReply({
			content: '🛑 Modo respaldo desactivado y WARP desconectado. Los avisos que ya estaban guardados se siguen enviando en la ventana.',
			components: [],
		});
		return;
	}

	setBackupMode(true);
	const result = await enableWarp();
	let content;
	if (result.ok) {
		content =
			'✅ Modo respaldo **activado**. WARP conectado y verificado (animeav1 respondió por WARP). ' +
			'Guardo los episodios nuevos en cada chequeo y los mando en la ventana de avisos.';
	} else if (result.reason === 'not-installed') {
		content =
			'⚠️ Modo respaldo **activado**, pero **WARP no está instalado** en la Pi: por ahora solo funciona guardar los avisos y mandarlos en la ventana ' +
			'(si animeav1 está bloqueado a la hora del chequeo, no lo puedo leer). Cuando se instale WARP, usá /respaldo-animeav1 para conectarlo.';
	} else if (result.reason === 'unverified') {
		content = '⚠️ Modo respaldo **activado**, pero WARP se conectó y no pude verificar que animeav1 responda por ahí, así que lo dejé desconectado.';
	} else {
		content = `⚠️ Modo respaldo **activado**, pero WARP falló: ${result.detail}. Sigo sin usarlo.`;
	}
	await interaction.editReply({ content, components: [] });
}

function onAv1FetchSuccess() {
	consecutiveFailures = 0;
}

// Minutos desde medianoche hasta el límite para mandar el MD automático (ver LAST_CHECKS_COUNT).
function promptDeadlineMinutes(checkIntervalMs) {
	const { endHour } = getNotifyWindow(process.env.GUILD_ID);
	return endHour * 60 - LAST_CHECKS_COUNT * (checkIntervalMs / 60_000) - DEADLINE_MARGIN_MIN;
}

// Se llama cuando falla la lectura de la home de animeav1. Pregunta por MD (como mucho una vez al día, y
// una vez por semana si se dijo que no); con el modo respaldo ya activo no pregunta nada. Solo hasta el
// límite de arriba; si este es el último chequeo que cae antes del límite, pregunta ya, sin esperar a la
// segunda falla.
async function onAv1FetchFailure(client, { checkIntervalMs, at = new Date() }) {
	consecutiveFailures++;
	if (isBackupMode()) return;

	const nowMin = at.getHours() * 60 + at.getMinutes();
	const deadlineMin = promptDeadlineMinutes(checkIntervalMs);
	if (nowMin > deadlineMin) return;
	const lastChance = nowMin + checkIntervalMs / 60_000 > deadlineMin;
	if (consecutiveFailures < FAILS_BEFORE_PROMPT && !lastChance) return;

	const now = Date.now();
	if (now - Number(getBotState(PROMPT_KEY) ?? 0) < PROMPT_COOLDOWN_MS) return;
	if (now - Number(getBotState(DECLINED_KEY) ?? 0) < DECLINED_COOLDOWN_MS) return;

	setBotState(PROMPT_KEY, now);
	try {
		await sendBackupPrompt(client, { manual: false });
		console.log('[av1Backup] le pregunté al dueño por MD si activa el modo respaldo');
	} catch (err) {
		console.error('[av1Backup] no pude mandar el MD al dueño:', err.message);
	}
}

module.exports = { getOwnerId, buildPromptMessage, sendBackupPrompt, handleAv1WarpButton, onAv1FetchSuccess, onAv1FetchFailure };
