// Los hilos de los foros se ocultan solos (se archivan) tras 3 días sin actividad. Editar un mensaje o
// cambiar el nombre de un hilo archivado falla (error 50083 "Thread is archived"), así que antes de
// tocarlo se reabre. No lanza: si no se puede reabrir, la operación siguiente fallará y quien la llama ya
// registra ese error. Devuelve true solo si lo reabrió.
async function reabrirSiArchivado(hilo) {
	if (!hilo?.archived) return false;
	try {
		await hilo.setArchived(false, 'El bot necesita actualizar este hilo');
		return true;
	} catch (err) {
		console.error(`[hilos] no pude reabrir "${hilo.name}":`, err.message);
		return false;
	}
}

module.exports = { reabrirSiArchivado };
