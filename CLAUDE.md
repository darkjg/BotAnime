# BotAnime — notas para Claude Code

Bot de Discord de anime. Proyecto independiente de `../Aurora` y `../BotDCOCR`.

## Idioma: aquí SÍ va en español
A diferencia de Aurora (inglés obligatorio), este bot es **en español de cara al usuario**:
nombres de comandos incluidos (`/recordatorio`, etc.). No "traducirlo" al inglés por costumbre.

## Despliegue: a la Raspberry Pi, a mano
No hay carpeta espejo (a diferencia de Aurora/BotDCOCR). Se sube por `scp` y corre bajo **pm2**:

- `ssh raspi`, el proyecto vive en `~/BotAnimu`
- Tras subir cambios hay que reiniciar el proceso de pm2
- Registrar comandos nuevos: `deploy-commands.js`

**Nunca tocar `botanime.sqlite`** (está en la Pi, con datos reales). No subirlo ni sobrescribirlo.

## Antes de editar: finales de línea MIXTOS
Este repo **no es uniforme**, así que no asumir LF:

| archivo | |
|---|---|
| `src/services/db.js` | **CRLF** |
| `src/services/dbSchema.js` | **CRLF** |
| `src/reminders.js`, `src/remindersService.js`, `src/commands/*.js` | LF |

**Preservar los de cada archivo**, comprobando antes y después. El `replace()` de Python convierte
LF a CRLF de forma silenciosa; usar operaciones de cadena de Node para no corromperlos.

Después de editar: `node --check`. No hay tests automáticos.

## Dónde está qué
- `Bot.js` — punto de entrada (no hay `index.js`).
- `src/commands/` — un archivo por comando slash.
- `src/services/db.js` — acceso a datos; `src/services/dbSchema.js` aplica el esquema y las
  migraciones (`ALTER TABLE` con guardas dentro de `applySchema()`).
- `src/reminders.js` — parseo de duraciones y cálculo de la siguiente ocurrencia.
- `src/remindersService.js` — avisador periódico.

## Recordatorios: repetición
Los recordatorios admiten repetición (`repeat_every_ms` en la tabla `reminders`). Al vencer, uno
repetido **se reprograma a su siguiente ocurrencia futura** en vez de marcarse como avisado; así un
bot apagado un tiempo no dispara una ráfaga de avisos atrasados. Si el canal se perdió
(códigos 10003 / 50001 / 50013) deja de repetirse; un fallo de red pasajero no.
