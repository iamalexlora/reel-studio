// Reel Studio — app para Windows.
// Ventana propia (WebView2) que actualiza el programa desde GitHub, arranca el servidor local
// de %USERPROFILE%\ReelStudio y muestra el editor. Al cerrar, apaga el servidor.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ReelStudio
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            bool created;
            using (var mutex = new Mutex(true, "ReelStudio-ventana-unica", out created))
            {
                if (!created) { return; }   // ya hay una ventana abierta
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
            }
        }
    }

    class MainForm : Form
    {
        const int Port = 8765;
        static readonly string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        static readonly string Root = Path.Combine(Home, "ReelStudio");
        static readonly string Py = Path.Combine(Root, "runtime", "python", "python.exe");
        static readonly string Cfg = Path.Combine(Root, "config", "update.json");
        const string EditorUrl = "http://localhost:8765/";
        const string TokenPage = "https://github.com/settings/personal-access-tokens/new";

        readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill };
        Process server;
        bool booting, closingOk;

        public MainForm()
        {
            Text = "Reel Studio";
            ClientSize = new Size(1400, 860);
            MinimumSize = new Size(900, 600);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(243, 244, 241);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            var menu = new MenuStrip();
            var m = new ToolStripMenuItem("Reel Studio");
            m.DropDownItems.Add("Buscar actualizaciones…", null, (s, e) => CheckUpdates());
            m.DropDownItems.Add("Token de GitHub…", null, (s, e) => Task.Run(() => AskToken(true)));
            m.DropDownItems.Add(new ToolStripSeparator());
            m.DropDownItems.Add("Abrir en el navegador", null, (s, e) => Open(EditorUrl));
            m.DropDownItems.Add("Mostrar carpeta de proyectos", null, (s, e) =>
            {
                var p = Path.Combine(Root, "proyectos"); Directory.CreateDirectory(p); Open(p);
            });
            m.DropDownItems.Add("Recargar", null, (s, e) => Reload());
            m.DropDownItems.Add(new ToolStripSeparator());
            m.DropDownItems.Add("Salir", null, (s, e) => Close());
            menu.Items.Add(m);
            MainMenuStrip = menu;
            Controls.Add(web);
            Controls.Add(menu);

            Load += async (s, e) => await InitAsync();
            FormClosing += OnClosingForm;
        }

        // ------------------------------------------------------------ arranque

        async Task InitAsync()
        {
            try
            {
                var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                                        "ReelStudio", "WebView2");
                var env = await CoreWebView2Environment.CreateAsync(null, data);
                await web.EnsureCoreWebView2Async(env);
            }
            catch (Exception ex)
            {
                var r = MessageBox.Show(
                    "Reel Studio necesita «Microsoft Edge WebView2», que viene con Windows 11 y con Windows 10 actualizado.\n\n" +
                    "¿Abrir la página de descarga?\n\n(" + ex.Message + ")",
                    "Falta un componente", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (r == DialogResult.Yes) Open("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
                closingOk = true; Close();
                return;
            }
            var core = web.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.NewWindowRequested += (s, e) => { e.Handled = true; Open(e.Uri); };
            core.NavigationStarting += (s, e) =>
            {
                if (!e.Uri.StartsWith("http://localhost") && !e.Uri.StartsWith("http://127.0.0.1") &&
                    !e.Uri.StartsWith("data:") && !e.Uri.StartsWith("about:"))
                { e.Cancel = true; Open(e.Uri); }
            };
            core.NavigationCompleted += (s, e) =>
            {
                if (!e.IsSuccess && core.Source.StartsWith("http://localhost") && !booting)
                {
                    Status("Reel Studio se detuvo", "Volviendo a abrir…");
                    Task.Run(() => Boot());
                }
            };
            Status("Abriendo Reel Studio", "Un momento…");
            await Task.Run(() => Boot());
        }

        void Boot()
        {
            if (booting) return;
            booting = true;
            try
            {
                if (!File.Exists(Py) || !File.Exists(Path.Combine(Root, "app", "server.py")))
                {
                    Status("Falta reinstalar", "No encuentro los archivos de Reel Studio en " + Root +
                           ". Vuelve a ejecutar el instalador.", false);
                    return;
                }
                EnsureConfig();
                AskToken(false);

                if (!ServerUp())
                {
                    Status("Abriendo Reel Studio", "Buscando actualizaciones…");
                    Run(Py, Q(Path.Combine(Root, "app", "updater.py")) + " apply", 180000);
                    StartServer();
                }
                for (int i = 0; i < 120; i++)
                {
                    if (ServerUp()) { Navigate(EditorUrl); return; }
                    Thread.Sleep(500);
                }
                Status("No pude abrir Reel Studio",
                       "El servidor no arrancó. Revisa " + Path.Combine(Root, "logs", "servidor.log"), false);
            }
            finally { booting = false; }
        }

        void StartServer()
        {
            Directory.CreateDirectory(Path.Combine(Root, "logs"));
            var log = Path.Combine(Root, "logs", "servidor.log");
            var psi = new ProcessStartInfo(Py, "server.py")
            {
                WorkingDirectory = Path.Combine(Root, "app"),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            psi.EnvironmentVariables["PYTHONUTF8"] = "1";
            psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
            server = new Process { StartInfo = psi, EnableRaisingEvents = true };
            DataReceivedEventHandler w = (s, e) =>
            {
                if (e.Data == null) return;
                try { lock (this) File.AppendAllText(log, e.Data + Environment.NewLine, Encoding.UTF8); } catch { }
            };
            server.OutputDataReceived += w;
            server.ErrorDataReceived += w;
            server.Start();
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();
        }

        // ------------------------------------------------------------ actualizaciones y token

        void EnsureConfig()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Cfg));
            if (!File.Exists(Cfg))
                File.WriteAllText(Cfg, "{\n \"repo\": \"iamalexlora/reel-studio\",\n \"branch\": \"main\",\n \"token\": \"\"\n}\n");
        }

        static string JsonStr(string json, string key)
        {
            var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
            return m.Success ? m.Groups[1].Value : "";
        }

        static void WriteCfg(string repo, string branch, string token, bool skip)
        {
            Func<string, string> esc = x => x.Replace("\\", "\\\\").Replace("\"", "\\\"");
            File.WriteAllText(Cfg, "{\n \"repo\": \"" + esc(repo) + "\",\n \"branch\": \"" + esc(branch) +
                                   "\",\n \"token\": \"" + esc(token) + "\",\n \"skipToken\": " +
                                   (skip ? "true" : "false") + "\n}\n");
        }

        void AskToken(bool force)
        {
            EnsureConfig();
            var json = File.ReadAllText(Cfg);
            var repo = JsonStr(json, "repo"); if (repo == "") repo = "iamalexlora/reel-studio";
            var branch = JsonStr(json, "branch"); if (branch == "") branch = "main";
            var token = JsonStr(json, "token");
            var skip = Regex.IsMatch(json, "\"skipToken\"\\s*:\\s*true");
            if (!force && (token != "" || skip)) return;

            Invoke((Action)(() =>
            {
                using (var f = new Form())
                {
                    f.Text = "Activar actualizaciones automáticas";
                    f.FormBorderStyle = FormBorderStyle.FixedDialog;
                    f.MaximizeBox = f.MinimizeBox = false;
                    f.StartPosition = FormStartPosition.CenterParent;
                    f.ClientSize = new Size(480, 190);
                    f.Font = new Font("Segoe UI", 9.5f);
                    var lbl = new Label
                    {
                        Text = "Tu repositorio de GitHub es privado. Pega el token de solo lectura " +
                               "(empieza con github_pat_) para que Reel Studio se actualice solo cada vez que hagas cambios.",
                        Location = new Point(16, 14), Size = new Size(448, 60)
                    };
                    var box = new TextBox { Location = new Point(16, 80), Width = 448, UseSystemPasswordChar = true };
                    var ok = new Button { Text = "Guardar", Location = new Point(264, 140), Width = 96, DialogResult = DialogResult.OK };
                    var no = new Button { Text = "Ahora no", Location = new Point(368, 140), Width = 96, DialogResult = DialogResult.Cancel };
                    var help = new LinkLabel { Text = "Cómo crear el token", Location = new Point(16, 146), AutoSize = true };
                    help.LinkClicked += (s, e) => Open(TokenPage);
                    f.Controls.AddRange(new Control[] { lbl, box, ok, no, help });
                    f.AcceptButton = ok; f.CancelButton = no;
                    var r = f.ShowDialog(this);
                    var t = box.Text.Trim();
                    if (r == DialogResult.OK && t != "") WriteCfg(repo, branch, t, false);
                    else if (r == DialogResult.Cancel) WriteCfg(repo, branch, token, true);
                }
            }));
        }

        void CheckUpdates()
        {
            Task.Run(() =>
            {
                var outp = Run(Py, Q(Path.Combine(Root, "app", "updater.py")) + " apply", 180000);
                var updated = outp.Contains("\"updated\": true");
                if (updated)
                {
                    Shutdown();
                    Boot();
                }
                Invoke((Action)(() => MessageBox.Show(this,
                    updated ? "Reel Studio se actualizó." :
                    (outp.Contains("No se pudo") || outp.Contains("no configuradas")) ? "No se pudo buscar actualizaciones:\n\n" + outp.Trim()
                    : "Ya tienes la última versión.",
                    "Reel Studio")));
            });
        }

        // ------------------------------------------------------------ salir

        void OnClosingForm(object sender, FormClosingEventArgs e)
        {
            if (closingOk) return;
            var jobs = Get("/api/jobs");
            if (jobs != null && (jobs.Contains("\"export\"") || jobs.Contains("\"transcribe\"")))
            {
                var r = MessageBox.Show(this, "Reel Studio está exportando o transcribiendo. Si cierras ahora, se cancela.\n\n¿Cerrar igual?",
                                        "Hay un trabajo en curso", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (r == DialogResult.No) { e.Cancel = true; return; }
            }
            closingOk = true;
            Shutdown();
        }

        void Shutdown()
        {
            Post("/api/shutdown");
            for (int i = 0; i < 20 && ServerUp(); i++) Thread.Sleep(150);
            try { if (server != null && !server.HasExited) Run("taskkill", "/PID " + server.Id + " /T /F", 5000); } catch { }
        }

        // ------------------------------------------------------------ utilidades

        void Reload()
        {
            if (web.CoreWebView2 != null && web.CoreWebView2.Source.StartsWith("http://localhost")) web.CoreWebView2.Reload();
            else Task.Run(() => Boot());
        }

        void Navigate(string url) => BeginInvoke((Action)(() => web.CoreWebView2?.Navigate(url)));

        void Status(string title, string text, bool spinner = true)
        {
            var html = "<!doctype html><html><head><meta charset=utf-8><style>" +
                "body{margin:0;height:100vh;display:grid;place-items:center;font:15px/1.5 'Segoe UI',system-ui;background:#F3F4F1;color:#17201D}" +
                "@media (prefers-color-scheme:dark){body{background:#141917;color:#E8ECE9}}" +
                ".c{max-width:460px;text-align:center;padding:24px}h1{font:600 26px/1.2 Georgia,serif;margin:0 0 10px}p{margin:0;opacity:.75}" +
                ".s{width:28px;height:28px;margin:22px auto 0;border:3px solid rgba(43,91,215,.25);border-top-color:#2B5BD7;border-radius:50%;animation:r 1s linear infinite}" +
                "@keyframes r{to{transform:rotate(360deg)}}</style></head><body><div class=c><h1>" +
                WebUtility.HtmlEncode(title) + "</h1><p>" + WebUtility.HtmlEncode(text) + "</p>" +
                (spinner ? "<div class=s></div>" : "") + "</div></body></html>";
            BeginInvoke((Action)(() => web.CoreWebView2?.NavigateToString(html)));
        }

        static string Q(string p) => "\"" + p + "\"";

        static void Open(string target)
        {
            try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); } catch { }
        }

        static string Run(string exe, string args, int timeoutMs)
        {
            try
            {
                var psi = new ProcessStartInfo(exe, args)
                {
                    UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Root,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
                };
                psi.EnvironmentVariables["PYTHONUTF8"] = "1";
                psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
                using (var p = Process.Start(psi))
                {
                    var o = p.StandardOutput.ReadToEndAsync();
                    var er = p.StandardError.ReadToEndAsync();
                    if (!p.WaitForExit(timeoutMs)) { try { p.Kill(); } catch { } }
                    return o.Result + er.Result;
                }
            }
            catch (Exception ex) { return "No se pudo: " + ex.Message; }
        }

        static string Get(string path)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port + path);
                req.Proxy = null; req.Timeout = 1500; req.ReadWriteTimeout = 1500;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    return resp.StatusCode == HttpStatusCode.OK ? sr.ReadToEnd() : null;
            }
            catch { return null; }
        }

        static void Post(string path)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port + path);
                req.Proxy = null; req.Method = "POST"; req.Timeout = 1500; req.ContentLength = 0;
                using (req.GetResponse()) { }
            }
            catch { }
        }

        static bool ServerUp() => Get("/api/health") != null;
    }
}
