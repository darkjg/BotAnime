# BotAnime

Bot de Discord para comunidades de anime: organiza temporadas por hilos de foro, hace seguimiento de quién va al día con cada serie, avisa automáticamente de episodios nuevos y limpia los enlaces rotos de X/Twitter.

## Características

**Gestión de temporadas**
- Publica los animes de una temporada como hilos de foro, uno por serie, para votar cuáles se van a ver en grupo.
- Reconstrucción y reparación automática de temporadas si algo falla o cambia el catálogo a mitad de emisión.
- Voto restringido a un rol configurable por servidor.

**Seguimiento de progreso**
- Cada usuario marca hasta qué episodio va, por serie.
- `/en-comun`: compara tu progreso con el de otro usuario para ver qué animes coincidís viendo.
- `/pendientes`: lista los episodios que te faltan, y en cuáles vas a la par con otros.

**Notificaciones automáticas**
- Scheduler que vigila nuevos episodios (scraping de AV1/nyaa.si) y avisa en un canal configurable en cuanto salen.
- Recarga manual de episodios (`recarga-caps`) por si el scheduler se pierde alguno.

**Corrección de enlaces rotos (X/Twitter)**
- Detecta enlaces de x.com/twitter.com, consulta la API de fxtwitter para saber si el embed nativo de Discord se vería roto (galería de varias fotos, vídeo, o contenido NSFW) y **solo entonces** interviene.
- Borra el mensaje original y lo reenvía vía webhook con el nombre y avatar de quien lo escribió, para que quede claro quién lo mandó sin que parezca dicho por el bot.
- Reacción 🗑️ en el mensaje reenviado: solo el autor original (o un admin) puede usarla para borrarlo.

**Integraciones**
- Google Sheets, para registrar votos/progreso de forma legible fuera de Discord.
- Jikan API (MyAnimeList) para datos de las series.

## Stack técnico

- **Node.js** + **Discord.js v14** (slash commands, foros, componentes de interacción, webhooks)
- **SQLite** para el estado persistente (temporadas, votos, progreso)
- **Google Sheets API** (`googleapis`)
- Scraping ligero (AV1/nyaa.si) + **Jikan API** para metadatos de anime

## Puesta en marcha

```bash
npm install
node deploy-commands.js   # registra los slash commands
npm run dev               # arranca el bot (node --watch Bot.js)
```

Variables de entorno necesarias en `.env`: token del bot de Discord, credenciales de la cuenta de servicio de Google (Sheets), y el ID de la hoja de cálculo. Ver `Bot.js` para el detalle de intents/permisos requeridos (incluye el intent privilegiado *Message Content*, necesario para detectar enlaces de X/Twitter a corregir).
