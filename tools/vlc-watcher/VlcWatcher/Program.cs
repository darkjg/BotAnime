// Vigilante de VLC para BotAnime.
//
// Detecta cuando terminas de ver un capítulo descargado de animeav1.com (por el nombre de archivo
// que deja al descargar, tipo "197_1180_SUB.mkv" - sin renombrar) o un release de Erai-raws (tipo
// "[Erai-raws] Black Clover 2nd Season - 01 [...]", también sin renombrar) y avisa al bot para que
// marque ese capítulo como visto: a ti, y a quien esté contigo en tu mismo canal de voz de Discord
// que también siga ese anime.
//
// PRIMER USO:
//   1. En Discord, escribe /vlc-watcher-token y copia el token que te da (es privado, no lo
//      compartas - sirve para que el bot sepa que eres tú).
//   2. Activa la interfaz web de VLC (una sola vez):
//        Herramientas > Preferencias > abajo a la izquierda, "Mostrar todos"
//        > Interfaz > Interfaces principales > marca la casilla "Web"
//        > busca "lua" en el buscador de Preferencias > en "Intérprete Lua" pon una contraseña
//          cualquiera en "Contraseña Lua HTTP" (la que quieras, la necesitarás aquí; es
//          obligatoria, VLC rechaza las conexiones si se deja en blanco)
//        > Guarda, y cierra y vuelve a abrir VLC del todo para que tome el cambio.
//   3. Ejecuta VlcWatcher.exe. La primera vez te pedirá el token y la contraseña de VLC, y los
//      guarda en "config.json" (junto al .exe) para no volver a pedírtelos.
//   4. Para que quede corriendo siempre (incluso si lo cierras sin querer, o tras reiniciar el PC
//      antes de iniciar sesión), instálalo como servicio de Windows desde una consola de
//      administrador:  VlcWatcher.exe -install-service
//
// Para quitarlo de en medio:  VlcWatcher.exe -uninstall-service  (también desde administrador).
// Para ver los logs en vivo en una ventana en vez de en segundo plano:  VlcWatcher.exe -debug

using System.Diagnostics;
using System.Management;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Logging;

namespace VlcWatcher;

internal static class Program
{
	private const string ServiceName = "VlcWatcher";
	private const string BotUrl = "https://newjg.chickenkiller.com/vlc-watched";
	private const string VlcStatusUrl = "http://localhost:8080/requests/status.json";
	private const string VlcPlaylistUrl = "http://localhost:8080/requests/playlist.json";
	private const double UmbralVisto = 0.90; // a partir de qué % del capítulo se considera "visto"
	private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);

	// Nombre que deja animeav1 al descargar: "<id>_<capitulo>_SUB.ext" o "..._DUB.ext" - el id es el
	// interno de animeav1 (ver av1_media_ids en el bot), no tiene nada que ver con MyAnimeList.
	private static readonly Regex NombreArchivoRe = new(@"^(\d+)_(\d+)_", RegexOptions.Compiled);

	// Nombre típico de un release de Erai-raws (torrent, no animeav1):
	// "[Erai-raws] <Título> - <capítulo> [1080p ...][...][hash]" - sin ningún id propio, así que el
	// bot tiene que cruzar el título contra los animes que sigues (ver resolverMalIdPorTitulo en
	// watchServer.js). El título puede traer numerales de temporada ("2nd Season") que el bot ya sabe
	// normalizar igual que hace con los títulos de animeav1.
	private static readonly Regex EraiNombreRe = new(@"^\[Erai-raws\]\s*(.+?)\s*-\s*(\d+)\s*\[", RegexOptions.Compiled);

	private static readonly string ConfigPath = Path.Combine(AppContext.BaseDirectory, "config.json");
	private static readonly string LogPath = Path.Combine(AppContext.BaseDirectory, "watcher.log");
	private static readonly object LogLock = new();

	// FreeConsole (en vez del viejo truco de GetConsoleWindow+ShowWindow) desconecta el proceso de la
	// terminal del todo - ShowWindow ocultaba la ventana de la consola clásica, pero no la pestaña
	// cuando se lanza desde Windows Terminal (esa pestaña la controla wt.exe, no este proceso).
	[DllImport("kernel32.dll")]
	private static extern bool FreeConsole();

	private static async Task<int> Main(string[] args)
	{
		Console.OutputEncoding = System.Text.Encoding.UTF8; // sin esto, los acentos salen rotos en la consola de Windows

		AppDomain.CurrentDomain.UnhandledException += (_, exArgs) =>
			Log($"FATAL: excepción no manejada, el proceso va a terminar: {exArgs.ExceptionObject}");

		if (args.Any(a => string.Equals(a, "-install-service", StringComparison.OrdinalIgnoreCase)))
		{
			InstalarServicio();
			return 0;
		}
		if (args.Any(a => string.Equals(a, "-uninstall-service", StringComparison.OrdinalIgnoreCase)))
		{
			DesinstalarServicio();
			return 0;
		}

		var debug = args.Any(a => string.Equals(a, "-debug", StringComparison.OrdinalIgnoreCase));
		var esServicio = WindowsServiceHelpers.IsWindowsService();

		var config = CargarConfig();
		if (config is null)
		{
			if (esServicio)
			{
				// El servicio no tiene consola para pedir el token/contraseña - hace falta correr el
				// .exe a mano (doble clic) una vez primero para que exista config.json.
				Log("FATAL: no hay config.json todavía - ejecuta el .exe a mano una vez para configurarlo antes de instalar el servicio.");
				return 1;
			}

			config = PedirConfiguracionInicial();
			GuardarConfig(config);
			Console.WriteLine("\nGuardado.");
			Console.WriteLine("Para que se quede corriendo siempre (incluso si lo cierras sin querer, o antes de");
			Console.WriteLine("iniciar sesión tras reiniciar el PC), instálalo como servicio desde una consola de");
			Console.WriteLine("administrador:  VlcWatcher.exe -install-service");
			Console.WriteLine("\nEsta ventana se cerrará sola en 8 segundos...");
			await Task.Delay(TimeSpan.FromSeconds(8));
			return 0;
		}

		if (!esServicio && !debug) FreeConsole();

		Log("=== VlcWatcher arrancando ===");

		// AddWindowsService hace que este mismo host funcione tanto si lo lanza el SCM (servicio real,
		// con sus señales de start/stop) como si se ejecuta suelto (consola/-debug) - no hace falta
		// bifurcar la lógica a mano entre los dos casos.
		var builder = Host.CreateApplicationBuilder(args);
		builder.Services.AddWindowsService(options => options.ServiceName = ServiceName);
		builder.Services.AddHostedService(_ => new VigilanteService(config));
		builder.Logging.ClearProviders(); // el log propio ya escribe a watcher.log; no hace falta el de Hosting

		using var host = builder.Build();
		await host.RunAsync();
		return 0;
	}

	private static bool EsAdministrador()
	{
		using var identity = WindowsIdentity.GetCurrent();
		return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
	}

	// sc.exe (crear/instalar un servicio) exige permisos de administrador - en vez de obligar a abrir
	// la consola ya elevada, esto se relanza a sí mismo pidiendo elevación (un solo UAC) si hace falta.
	private static void RelanzarElevado(string argumento)
	{
		try
		{
			var psi = new ProcessStartInfo(Environment.ProcessPath!, argumento) { UseShellExecute = true, Verb = "runas" };
			Process.Start(psi);
		}
		catch (Exception ex)
		{
			Console.WriteLine($"No pude pedir permisos de administrador: {ex.Message}");
		}
	}

	private static void InstalarServicio()
	{
		if (!EsAdministrador())
		{
			RelanzarElevado("-install-service");
			return;
		}

		var exePath = Environment.ProcessPath!;
		EjecutarSc($"create {ServiceName} binPath= \"{exePath}\" start= auto DisplayName= \"VlcWatcher - BotAnime\"");
		EjecutarSc($"description {ServiceName} \"Marca en el bot de Discord de BotAnime los capitulos de anime vistos en VLC.\"");
		// Si se cae por lo que sea, que Windows lo vuelva a levantar solo en vez de quedarse muerto
		// hasta el próximo reinicio - "reset= 86400" reinicia el contador de reintentos tras un día
		// sin fallos, para no agotar los 3 intentos por una racha vieja de caídas ya resueltas.
		EjecutarSc($"failure {ServiceName} reset= 86400 actions= restart/5000/restart/5000/restart/60000");
		EjecutarSc($"start {ServiceName}");
		Console.WriteLine("\nServicio instalado y arrancado. Esta ventana se cierra sola en unos segundos...");
		Thread.Sleep(TimeSpan.FromSeconds(6));
	}

	private static void DesinstalarServicio()
	{
		if (!EsAdministrador())
		{
			RelanzarElevado("-uninstall-service");
			return;
		}

		EjecutarSc($"stop {ServiceName}");
		EjecutarSc($"delete {ServiceName}");
		Console.WriteLine("\nServicio desinstalado. Esta ventana se cierra sola en unos segundos...");
		Thread.Sleep(TimeSpan.FromSeconds(6));
	}

	private static void EjecutarSc(string argumentos)
	{
		var psi = new ProcessStartInfo("sc.exe", argumentos) { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true };
		using var proceso = Process.Start(psi)!;
		var salida = proceso.StandardOutput.ReadToEnd();
		proceso.WaitForExit();
		Console.WriteLine(salida.Trim());
	}

	// Log a archivo (no solo a consola, que la mayor parte del tiempo está oculta o no existe - un
	// servicio no tiene consola) para poder ver qué pasó después. Se trunca si crece demasiado para no
	// llenar el disco en semanas de uso continuo.
	private static void Log(string mensaje)
	{
		var linea = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {mensaje}";
		try { Console.WriteLine(linea); } catch { /* sin consola (servicio): no pasa nada */ }
		try
		{
			lock (LogLock)
			{
				if (File.Exists(LogPath) && new FileInfo(LogPath).Length > 2_000_000)
				{
					File.WriteAllText(LogPath, "(log truncado por tamaño)\n");
				}
				File.AppendAllText(LogPath, linea + Environment.NewLine);
			}
		}
		catch
		{
			// si no se puede escribir el log (disco lleno, permisos...) no es motivo para caerse
		}
	}

	internal sealed record Config(string Token, string VlcPassword);

	private static Config? CargarConfig()
	{
		if (!File.Exists(ConfigPath)) return null;
		try
		{
			var json = File.ReadAllText(ConfigPath);
			return JsonSerializer.Deserialize<Config>(json);
		}
		catch
		{
			return null; // config corrupto: se trata como "primera vez" en vez de reventar
		}
	}

	private static void GuardarConfig(Config config)
	{
		File.WriteAllText(ConfigPath, JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true }));
	}

	private static Config PedirConfiguracionInicial()
	{
		Console.WriteLine("=== Primera vez: configuración (solo hace falta una vez) ===");
		Console.Write("Pega tu token de /vlc-watcher-token: ");
		var token = (Console.ReadLine() ?? "").Trim();
		Console.Write("Contraseña que pusiste en VLC (Intérprete Lua > Lua HTTP > Contraseña): ");
		var vlcPassword = (Console.ReadLine() ?? "").Trim();
		return new Config(token, vlcPassword);
	}

	internal static async Task Vigilar(Config config, CancellationToken stoppingToken)
	{
		using var vlcClient = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
		var auth = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes($":{config.VlcPassword}"));
		vlcClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic", auth);

		using var botClient = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };

		var yaAvisado = new HashSet<string>();
		var ultimoErrorLogueado = DateTime.MinValue;

		Log("Vigilando VLC...");

		while (!stoppingToken.IsCancellationRequested)
		{
			if (!VlcEstaCorriendo())
			{
				// En vez de sondear "¿ya abriste VLC?" en un bucle propio, nos quedamos dormidos del
				// todo (sin CPU ni red) hasta que Windows nos avise de que el proceso de VLC arrancó -
				// es justo el "que avise VLC en vez de preguntar todo el rato" pero aplicado a detectar
				// que se abrió, que es lo único para lo que Windows ofrece un aviso así de nativo.
				Log("VLC no está abierto, durmiendo hasta que arranque...");
				EsperarAQueArranqueProceso("vlc.exe", stoppingToken);
				if (stoppingToken.IsCancellationRequested) break;
				Log("VLC detectado, reanudando vigilancia.");
			}

			try
			{
				await RevisarUnaVez(vlcClient, botClient, config.Token, yaAvisado);
			}
			catch (Exception ex)
			{
				// Red caída, interfaz Web de VLC no activada, lo que sea: se ignora y se reintenta en el
				// próximo ciclo - este programa tiene que sobrevivir indefinidamente sin intervención de
				// nadie. Se loguea igualmente (con un mínimo de tiempo entre logs) para poder ver el
				// motivo si nunca llega a avisar al bot.
				if (DateTime.Now - ultimoErrorLogueado > TimeSpan.FromMinutes(2))
				{
					Log($"(ciclo de vigilancia con error, se reintenta: {ex.Message})");
					ultimoErrorLogueado = DateTime.Now;
				}
			}

			try
			{
				await Task.Delay(PollInterval, stoppingToken);
			}
			catch (OperationCanceledException)
			{
				break; // el servicio está parando - cortar el bucle limpio, sin loguearlo como error
			}
		}

		Log("Vigilancia detenida (el servicio está parando).");
	}

	// Por nombre de proceso, no por si responde el puerto 8080 - así no hace falta tocar la red para
	// saber que no hay nada escuchando ahí.
	private static bool VlcEstaCorriendo()
	{
		var procesos = Process.GetProcessesByName("vlc");
		try
		{
			return procesos.Length > 0;
		}
		finally
		{
			foreach (var p in procesos) p.Dispose();
		}
	}

	// Bloquea el hilo (sin poll propio, sin CPU) suscrito al evento WMI de creación de proceso - es
	// el propio Windows el que nos despierta cuando arranca vlc.exe, no nosotros preguntando. WMI
	// reconsulta internamente cada pocos segundos (parte de "WITHIN 2" de la query), pero eso corre en
	// el servicio WMI del sistema, no en este proceso ni contra la red de VLC. Se espera en tandas
	// cortas (no un solo WaitForNextEvent sin límite) para poder reaccionar a stoppingToken si el
	// servicio para mientras no hay VLC abierto.
	private static void EsperarAQueArranqueProceso(string nombreProceso, CancellationToken stoppingToken)
	{
		try
		{
			using var watcher = new ManagementEventWatcher(new WqlEventQuery(
				"SELECT * FROM __InstanceCreationEvent WITHIN 2 WHERE TargetInstance ISA 'Win32_Process' " +
				$"AND TargetInstance.Name = '{nombreProceso}'"));
			watcher.Options.Timeout = TimeSpan.FromSeconds(5);
			while (!stoppingToken.IsCancellationRequested)
			{
				try
				{
					watcher.WaitForNextEvent();
					return;
				}
				catch (ManagementException mex) when (mex.ErrorCode == ManagementStatus.Timedout)
				{
					// Nada en estos 5s - se vuelve a esperar, es solo para poder revisar stoppingToken.
				}
			}
		}
		catch (Exception ex)
		{
			// Si WMI falla por lo que sea (permisos, servicio parado...) no tiene sentido quedarse
			// colgado para siempre: se cae a comprobar el proceso cada 30s como red de seguridad.
			Log($"(no pude esperar el evento de WMI, se vigila por sondeo cada 30s: {ex.Message})");
			while (!VlcEstaCorriendo() && !stoppingToken.IsCancellationRequested) Thread.Sleep(TimeSpan.FromSeconds(30));
		}
	}

	private static string? UltimoNombreSinFormatoLogueado;

	private static async Task RevisarUnaVez(HttpClient vlcClient, HttpClient botClient, string token, HashSet<string> yaAvisado)
	{
		var estado = await vlcClient.GetFromJsonAsync<JsonElement?>(VlcStatusUrl);
		if (estado is null) return;
		var e = estado.Value;

		// "paused" cuenta también: a veces VLC queda en pausa justo al llegar al final (visto en
		// pruebas reales), y también es razonable si alguien pausa justo tras terminar el capítulo -
		// lo que importa es hasta dónde llegó, no el estado exacto en este instante del sondeo.
		if (!e.TryGetProperty("state", out var stateProp)) return;
		var estadoActual = stateProp.GetString();
		if (estadoActual != "playing" && estadoActual != "paused") return;

		var nombre = ObtenerNombreArchivo(e);
		if (nombre is null)
		{
			// El status no trajo el nombre (pasa a veces) - se intenta sacar de la playlist.
			var playlist = await vlcClient.GetFromJsonAsync<JsonElement?>(VlcPlaylistUrl);
			if (playlist is not null) nombre = BuscarItemActual(playlist.Value);
			if (nombre is null) return;
		}

		var nombreOriginal = nombre;
		nombre = Path.GetFileNameWithoutExtension(nombre);

		// Primero animeav1 (tiene id propio, cruce más fiable); si no matchea, se prueba Erai-raws
		// (cruce por título, ver resolverMalIdPorTitulo en watchServer.js).
		var matchAv1 = NombreArchivoRe.Match(nombre);
		var matchErai = matchAv1.Success ? null : EraiNombreRe.Match(nombre);

		if (!matchAv1.Success && matchErai?.Success != true)
		{
			if (nombreOriginal != UltimoNombreSinFormatoLogueado)
			{
				Log($"Archivo en reproducción no tiene el formato esperado (animeav1 \"<id>_<capitulo>_SUB/DUB\" o Erai-raws \"[Erai-raws] Título - capitulo [...]\"), no se vigila: \"{nombreOriginal}\"");
				UltimoNombreSinFormatoLogueado = nombreOriginal;
			}
			return;
		}

		// VLC ya trae el progreso calculado (0-1) en "position" - más directo y preciso que dividir
		// time/length a mano (confirmado en vivo que coinciden). Si no viniera, se calcula igual.
		double progreso;
		if (e.TryGetProperty("position", out var posProp))
		{
			progreso = posProp.GetDouble();
		}
		else
		{
			var largo = e.TryGetProperty("length", out var lenProp) ? lenProp.GetDouble() : 0;
			var posicion = e.TryGetProperty("time", out var timeProp) ? timeProp.GetDouble() : 0;
			if (largo <= 0) return;
			progreso = posicion / largo;
		}

		if (progreso < UmbralVisto) return;

		string clave;
		object payload;
		string descripcion;
		if (matchAv1.Success)
		{
			var avId = int.Parse(matchAv1.Groups[1].Value);
			var episodio = int.Parse(matchAv1.Groups[2].Value);
			clave = $"av1:{avId}:{episodio}";
			payload = new { token, av1MediaId = avId, episode = episodio };
			descripcion = $"capítulo {episodio} (id {avId})";
		}
		else
		{
			var titulo = matchErai!.Groups[1].Value.Trim();
			var episodio = int.Parse(matchErai.Groups[2].Value);
			clave = $"erai:{titulo}:{episodio}";
			payload = new { token, title = titulo, episode = episodio };
			descripcion = $"capítulo {episodio} de \"{titulo}\" (Erai-raws)";
		}

		if (yaAvisado.Contains(clave)) return;

		Log($"{descripcion} al {progreso * 100:F0}% -> avisando al bot...");
		var (reintentable, mensaje) = await AvisarBot(botClient, payload);
		Log(mensaje);

		// Si fue un fallo de red/timeout no se marca como "ya avisado": la conexión a un servidor en
		// casa por DDNS a veces tarda o falla una vez y luego funciona (visto en pruebas reales) - sin
		// esto, un solo fallo pasajero perdía el capítulo para siempre hasta reiniciar el programa.
		// Si el bot sí respondió (aunque sea con un error suyo, ej. "no tenés voto registrado") no
		// tiene sentido reintentar - esa respuesta no va a cambiar.
		if (!reintentable) yaAvisado.Add(clave);
	}

	private static string? ObtenerNombreArchivo(JsonElement estado)
	{
		if (estado.TryGetProperty("information", out var info) &&
			info.TryGetProperty("category", out var category) &&
			category.TryGetProperty("meta", out var meta) &&
			meta.TryGetProperty("filename", out var filenameProp))
		{
			return filenameProp.GetString();
		}
		return null;
	}

	private static string? BuscarItemActual(JsonElement nodo)
	{
		if (nodo.TryGetProperty("current", out var current) && current.GetString() == "current")
		{
			return nodo.TryGetProperty("name", out var name) ? name.GetString() : null;
		}
		if (nodo.TryGetProperty("children", out var children) && children.ValueKind == JsonValueKind.Array)
		{
			foreach (var hijo in children.EnumerateArray())
			{
				var encontrado = BuscarItemActual(hijo);
				if (encontrado is not null) return encontrado;
			}
		}
		return null;
	}

	private sealed class RespuestaBot
	{
		public bool Ok { get; set; }
		public string? Error { get; set; }
		public string? Titulo { get; set; }
		public int Episode { get; set; }
		public List<string>? Marcados { get; set; }
	}

	// (reintentable, mensaje) - reintentable=true significa "no hubo respuesta real del bot, se puede
	// volver a intentar en el próximo sondeo sin problema" (fallo de red/timeout); reintentable=false
	// significa "el bot respondió" (lo haya marcado o no) y no tiene sentido volver a preguntarle.
	private static async Task<(bool Reintentable, string Mensaje)> AvisarBot(HttpClient client, object payload)
	{
		try
		{
			var respuesta = await client.PostAsJsonAsync(BotUrl, payload);
			var opciones = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
			var cuerpo = await respuesta.Content.ReadFromJsonAsync<RespuestaBot>(opciones);
			if (cuerpo is null) return (true, $"  Respuesta rara del bot (HTTP {(int)respuesta.StatusCode}), se reintentará.");
			return (false, cuerpo.Ok
				? $"  Listo: {cuerpo.Titulo} cap. {cuerpo.Episode} -> marcado para: {string.Join(", ", cuerpo.Marcados ?? [])}"
				: $"  No se pudo marcar: {cuerpo.Error}");
		}
		catch (Exception ex)
		{
			return (true, $"  No pude avisar al bot, se reintentará en el próximo sondeo: {ex.Message}");
		}
	}
}

// BackgroundService estándar de Microsoft.Extensions.Hosting: el mismo código corre igual si lo
// arranca el SCM (servicio real) o si el host se ejecuta suelto en consola.
internal sealed class VigilanteService(Program.Config config) : Microsoft.Extensions.Hosting.BackgroundService
{
	protected override Task ExecuteAsync(CancellationToken stoppingToken) => Program.Vigilar(config, stoppingToken);
}
