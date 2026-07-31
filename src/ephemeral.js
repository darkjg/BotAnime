const DEFAULT_DELAY_MS = 60_000;

// Borra sola una respuesta efímera pasado un rato, para que el canal no se llene de confirmaciones y
// errores que solo puede ver quien los pidió. No se usa en pasos intermedios de un flujo (selectores,
// modales) porque ahí el usuario todavía necesita interactuar con esos componentes.
function autoCleanupReply(interaction, delayMs = DEFAULT_DELAY_MS) {
	setTimeout(() => {
		interaction.deleteReply().catch(() => {});
	}, delayMs);
}

module.exports = { autoCleanupReply };
