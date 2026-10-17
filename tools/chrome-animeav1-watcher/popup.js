const tokenInput = document.getElementById('token');
const estado = document.getElementById('estado');

chrome.storage.local.get('token').then(({ token }) => {
	if (token) tokenInput.value = token;
});

document.getElementById('guardar').addEventListener('click', async () => {
	const token = tokenInput.value.trim();
	await chrome.storage.local.set({ token });
	estado.textContent = token ? 'Guardado.' : 'Token borrado.';
});
