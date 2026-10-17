const tokenInput = document.getElementById('token');
const estado = document.getElementById('estado');

browser.storage.local.get('token').then(({ token }) => {
	if (token) tokenInput.value = token;
});

document.getElementById('guardar').addEventListener('click', async () => {
	const token = tokenInput.value.trim();
	await browser.storage.local.set({ token });
	estado.textContent = token ? 'Guardado.' : 'Token borrado.';
});
