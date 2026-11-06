// Reel Studio — app para Mac.
// Ventana propia que arranca el servidor local de Reel Studio (~/ReelStudio) y muestra el editor.
// El programa (Python + interfaz) se actualiza solo desde GitHub; esta app casi nunca cambia.

import Cocoa
import WebKit

let port = 8765
let home = FileManager.default.homeDirectoryForCurrentUser
let root = home.appendingPathComponent("ReelStudio")
let appURL = URL(string: "http://localhost:\(port)/")!
let bundled = Bundle.main.resourceURL!.appendingPathComponent("reel-studio")
let tokenPage = URL(string: "https://github.com/settings/personal-access-tokens/new")!

// MARK: - utilidades

@discardableResult
func run(_ exe: String, _ args: [String], wait: Bool = true) -> (Int32, String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    p.environment = env
    p.currentDirectoryURL = FileManager.default.fileExists(atPath: root.path) ? root : home
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do { try p.run() } catch { return (-1, "\(error)") }
    if !wait { return (0, "") }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

func httpGet(_ path: String, timeout: TimeInterval = 1.5) -> Data? {
    guard let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return nil }
    var req = URLRequest(url: url)
    req.timeoutInterval = timeout
    req.cachePolicy = .reloadIgnoringLocalCacheData
    let sem = DispatchSemaphore(value: 0)
    var out: Data?
    URLSession.shared.dataTask(with: req) { data, resp, _ in
        if let r = resp as? HTTPURLResponse, r.statusCode == 200 { out = data }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + timeout + 0.5)
    return out
}

func serverUp() -> Bool { httpGet("/api/health") != nil }

func exists(_ rel: String) -> Bool {
    FileManager.default.fileExists(atPath: root.appendingPathComponent(rel).path)
}

func readJSON(_ url: URL) -> [String: Any] {
    guard let d = try? Data(contentsOf: url),
          let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
    return j
}

func writeJSON(_ obj: [String: Any], _ url: URL) {
    if let d = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]) {
        try? d.write(to: url)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

func statusPage(_ title: String, _ text: String, spinner: Bool = true) -> String {
    let spin = spinner ? "<div class=s></div>" : ""
    return """
    <!doctype html><html><head><meta charset=utf-8><style>
    :root{color-scheme:light dark}
    body{margin:0;height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,system-ui;
         background:#C9CBD0;color:#1D1D1F}
    @media (prefers-color-scheme:dark){body{background:#0B0B0C;color:#F5F5F7}}
    .c{max-width:440px;text-align:center;padding:24px}
    h1{font:600 26px/1.2 'New York',Georgia,serif;margin:0 0 10px}
    p{margin:0;opacity:.75}
    .s{width:28px;height:28px;margin:22px auto 0;border:3px solid rgba(43,91,215,.25);border-top-color:#2B5BD7;
       border-radius:50%;animation:r 1s linear infinite}
    @keyframes r{to{transform:rotate(360deg)}}
    </style></head><body><div class=c><h1>\(title)</h1><p>\(text)</p>\(spin)</div></body></html>
    """
}

// Franja invisible arriba para mover la ventana (y doble clic para agrandarla), encima del editor.
class DragBar: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with e: NSEvent) {
        if e.clickCount == 2 { window?.performZoom(nil) } else { window?.performDrag(with: e) }
    }
}

// MARK: - app

class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, NSWindowDelegate {
    var closing = false
    var window: NSWindow!
    var web: WKWebView!
    var booting = false

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMenu()
        let cfg = WKWebViewConfiguration()
        cfg.mediaTypesRequiringUserActionForPlayback = []
        // El editor ocupa también la franja de arriba (se ve el vidrio del programa detrás de los botones de la ventana)
        cfg.userContentController.addUserScript(WKUserScript(
            source: "document.documentElement.classList.add('mac-app')", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        web = WKWebView(frame: .zero, configuration: cfg)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.allowsMagnification = true
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.delegate = self
        window.title = "Reel Studio"          // se usa en el menú Ventana y Mission Control
        window.titleVisibility = .hidden        // pero no se muestra arriba
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(name: nil) { ap in
            ap.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(red: 0.043, green: 0.043, blue: 0.047, alpha: 1)
                                                                : NSColor(red: 0.788, green: 0.796, blue: 0.816, alpha: 1)
        }
        window.minSize = NSSize(width: 900, height: 600)
        let container = NSView()
        web.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(web)
        let bar = DragBar()
        bar.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(bar)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: container.leadingAnchor), web.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            web.topAnchor.constraint(equalTo: container.topAnchor), web.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            bar.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 78), bar.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            bar.topAnchor.constraint(equalTo: container.topAnchor), bar.heightAnchor.constraint(equalToConstant: 28),
        ])
        window.contentView = container
        window.center()
        window.setFrameAutosaveName("ReelStudioMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        showBlank()
        DispatchQueue.global(qos: .userInitiated).async { self.boot() }
    }

    func show(_ title: String, _ text: String, spinner: Bool = true) {
        DispatchQueue.main.async {
            self.web.loadHTMLString(statusPage(title, text, spinner: spinner), baseURL: nil)
        }
    }

    // Mientras arranca: solo el color de fondo del programa (el logo animado lo pone el editor al abrir).
    func showBlank() {
        let html = "<!doctype html><html><head><meta charset=utf-8><style>:root{color-scheme:light dark}" +
            "html,body{margin:0;height:100vh;background:#0B0B0C}@media (prefers-color-scheme:light){html,body{background:#C9CBD0}}" +
            "</style></head><body></body></html>"
        DispatchQueue.main.async { self.web.loadHTMLString(html, baseURL: nil) }
    }

    func loadEditor() {
        DispatchQueue.main.async { self.web.load(URLRequest(url: appURL)) }
    }

    // Prepara ~/ReelStudio, actualiza y arranca el servidor.
    func boot() {
        if booting { return }
        booting = true
        defer { booting = false }
        removeOldLauncher()
        var copied = false
        // Copia el programa que viene dentro de la app si falta o es de antes del actualizador.
        if !exists("app/server.py") || !exists("app/updater.py") {
            copied = true
            show("Preparando Reel Studio", "Copiando el programa…")
            try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            run("/usr/bin/rsync", ["-a", "--exclude", "proyectos", "--exclude", ".venv", "--exclude", "logs",
                                   "--exclude", "config", "--exclude", "VERSION",
                                   bundled.path + "/", root.path + "/"])
            run("/bin/chmod", ["+x", root.appendingPathComponent("start.sh").path,
                               root.appendingPathComponent("stop.sh").path,
                               root.appendingPathComponent("instalar.command").path])
        }
        let cfgDir = root.appendingPathComponent("config")
        let cfgFile = cfgDir.appendingPathComponent("update.json")
        if !FileManager.default.fileExists(atPath: cfgFile.path) {
            try? FileManager.default.createDirectory(at: cfgDir, withIntermediateDirectories: true)
            var c = readJSON(bundled.appendingPathComponent("config/update.json"))
            if c["repo"] == nil { c = ["repo": "iamalexlora/reel-studio", "branch": "main", "token": ""] }
            writeJSON(c, cfgFile)
        }
        // Si la app trae el token incluido (secreto de GitHub al compilar), se usa sin preguntar.
        var cur = readJSON(cfgFile)
        let bundledTok = (readJSON(bundled.appendingPathComponent("config/update.json"))["token"] as? String) ?? ""
        if ((cur["token"] as? String) ?? "").isEmpty && !bundledTok.isEmpty {
            cur["token"] = bundledTok
            cur["skipToken"] = false
            writeJSON(cur, cfgFile)
        }
        askTokenIfNeeded(cfgFile)

        // Primera vez en esta Mac: faltan ffmpeg / Python / modelo de voz.
        if !exists(".venv/bin/python") {
            FileManager.default.createFile(atPath: root.appendingPathComponent(".desde-app").path, contents: nil)
            show("Instalando componentes",
                 "Se abrió la Terminal para instalar lo necesario (ffmpeg y el modelo de voz). " +
                 "Si te pide la contraseña de tu Mac, escríbela ahí. Puede tardar 10–15 minutos; " +
                 "esta ventana se abre sola cuando termine.")
            run("/usr/bin/open", ["-a", "Terminal", root.appendingPathComponent("instalar.command").path])
            for _ in 0..<(45 * 60) {
                if serverUp() { loadEditor(); return }
                Thread.sleep(forTimeInterval: 1)
            }
            show("La instalación no terminó", "Revisa la ventana de Terminal y vuelve a abrir Reel Studio.", spinner: false)
            return
        }

        // Si quedó corriendo una versión vieja del servidor, se apaga para usar la nueva.
        if copied && serverUp() {
            run("/bin/bash", [root.appendingPathComponent("stop.sh").path])
            for _ in 0..<20 { if !serverUp() { break }; Thread.sleep(forTimeInterval: 0.25) }
        }
        showBlank()
        let (code, out) = run("/bin/bash", [root.appendingPathComponent("start.sh").path, "--sin-navegador"])
        for _ in 0..<60 {
            if serverUp() { loadEditor(); return }
            Thread.sleep(forTimeInterval: 0.5)
        }
        let tail = out.split(separator: "\n").suffix(4).joined(separator: "<br>")
        show("No pude abrir Reel Studio",
             "El servidor no arrancó (código \(code)). Revisa ~/ReelStudio/logs/servidor.log.<br><br>\(tail)",
             spinner: false)
    }

    func askTokenIfNeeded(_ cfgFile: URL) {
        var c = readJSON(cfgFile)
        let token = (c["token"] as? String) ?? ""
        if !token.isEmpty || (c["skipToken"] as? Bool) == true { return }
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            let a = NSAlert()
            a.messageText = "Activar actualizaciones automáticas"
            a.informativeText = "Tu repositorio de GitHub es privado. Pega el token de solo lectura " +
                "(empieza con github_pat_) para que Reel Studio se actualice solo cada vez que hagas cambios."
            let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 340, height: 24))
            field.placeholderString = "github_pat_…"
            a.accessoryView = field
            a.addButton(withTitle: "Guardar")
            a.addButton(withTitle: "Ahora no")
            a.addButton(withTitle: "Cómo crear el token")
            a.window.initialFirstResponder = field
            let r = a.runModal()
            if r == .alertFirstButtonReturn {
                let t = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty { c["token"] = t }
            } else if r == .alertSecondButtonReturn {
                c["skipToken"] = true
            } else {
                NSWorkspace.shared.open(tokenPage)
            }
            writeJSON(c, cfgFile)
            sem.signal()
        }
        sem.wait()
    }

    // El lanzador viejo (AppleScript en ~/Applications) ya no hace falta.
    func removeOldLauncher() {
        let old = home.appendingPathComponent("Applications/Reel Studio.app")
        let script = old.appendingPathComponent("Contents/Resources/Scripts/main.scpt")
        if FileManager.default.fileExists(atPath: script.path) {
            try? FileManager.default.trashItem(at: old, resultingItemURL: nil)
        }
    }

    // MARK: menús

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Acerca de Reel Studio", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Ocultar Reel Studio", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Salir de Reel Studio", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edición")
        edit.addItem(withTitle: "Deshacer", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Rehacer", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cortar", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copiar", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Pegar", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Seleccionar todo", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "Ver")
        view.addItem(withTitle: "Recargar", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Abrir en el navegador", action: #selector(openInBrowser), keyEquivalent: "")
        view.addItem(withTitle: "Mostrar carpeta de proyectos", action: #selector(openProjects), keyEquivalent: "")
        viewItem.submenu = view

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Ventana")
        win.addItem(withTitle: "Minimizar", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winItem.submenu = win
        NSApp.windowsMenu = win

        let updItem = NSMenuItem(); main.addItem(updItem)
        let upd = NSMenu(title: "Actualizaciones")
        upd.addItem(withTitle: "Buscar actualizaciones…", action: #selector(checkUpdates), keyEquivalent: "u")
        upd.addItem(withTitle: "Ver qué cambió", action: #selector(openChanges), keyEquivalent: "")
        updItem.submenu = upd

        let aboutItem = NSMenuItem(); main.addItem(aboutItem)
        let about = NSMenu(title: "Acerca de")
        about.addItem(withTitle: "Acerca de Reel Studio", action: #selector(showAbout), keyEquivalent: "")
        about.addItem(withTitle: "Créditos y herramientas", action: #selector(showCredits), keyEquivalent: "")
        about.addItem(.separator())
        about.addItem(withTitle: "Token de GitHub…", action: #selector(changeToken), keyEquivalent: "")
        about.addItem(.separator())
        about.addItem(withTitle: "Mostrar videos exportados", action: #selector(openExports), keyEquivalent: "")
        about.addItem(withTitle: "Mostrar carpeta de proyectos", action: #selector(openProjects), keyEquivalent: "")
        aboutItem.submenu = about
        NSApp.mainMenu = main
    }

    @objc func reload() {
        if web.url?.host == "localhost" { web.reload() } else { DispatchQueue.global().async { self.boot() } }
    }
    @objc func openInBrowser() { NSWorkspace.shared.open(appURL) }
    func versionText() -> String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "2"
        let sha = (try? String(contentsOf: root.appendingPathComponent("VERSION"), encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return sha.isEmpty ? v : "\(v) · \(sha.prefix(7))"
    }
    func creditsText() -> NSAttributedString {
        let body = """
        Editor de reels para Mac: transcribe, limpia silencios y muletillas, pone subtítulos y animaciones, da color y exporta.
        Todo se procesa en esta computadora.

        Hecho a pedido de iamalexlora, construido con Claude (Anthropic).

        Herramientas que usa por dentro
        • FFmpeg: cortes, color, transiciones y exportación (LGPL/GPL)
        • Whisper de OpenAI vía mlx-whisper: voz a texto (MIT)
        • HyperFrames de HeyGen: animaciones (Apache 2.0)
        • GSAP de GreenSock: movimiento de las animaciones (licencia estándar sin costo)
        • yt-dlp: bajar videos desde enlaces (Unlicense)
        • Pillow: dibujo de subtítulos (MIT-CMU)
        • Letras Poppins, Anton y Bebas Neue (SIL Open Font License)

        Usa los enlaces solo con videos tuyos o como referencia de estilo.
        """
        let para = NSMutableParagraphStyle(); para.alignment = .left; para.paragraphSpacing = 2
        return NSAttributedString(string: body, attributes: [.font: NSFont.systemFont(ofSize: 11), .paragraphStyle: para,
                                                             .foregroundColor: NSColor.labelColor])
    }
    @objc func showAbout() {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "Reel Studio",
            .applicationVersion: versionText(),
            .version: "",
            .credits: creditsText(),
        ])
    }
    @objc func showCredits() {
        let a = NSAlert()
        a.messageText = "Reel Studio \(versionText())"
        a.informativeText = creditsText().string
        a.addButton(withTitle: "Listo")
        a.addButton(withTitle: "Ver en GitHub")
        if a.runModal() == .alertSecondButtonReturn {
            let c = readJSON(root.appendingPathComponent("config/update.json"))
            let repo = (c["repo"] as? String) ?? "iamalexlora/reel-studio"
            if let u = URL(string: "https://github.com/\(repo)") { NSWorkspace.shared.open(u) }
        }
    }
    @objc func openExports() {
        let p = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Movies/Reel Studio")
        try? FileManager.default.createDirectory(at: p, withIntermediateDirectories: true)
        NSWorkspace.shared.open(p)
    }
    @objc func openChanges() {
        let c = readJSON(root.appendingPathComponent("config/update.json"))
        let repo = (c["repo"] as? String) ?? "iamalexlora/reel-studio"
        if let u = URL(string: "https://github.com/\(repo)/commits/main") { NSWorkspace.shared.open(u) }
    }
    @objc func openProjects() {
        let p = root.appendingPathComponent("proyectos")
        try? FileManager.default.createDirectory(at: p, withIntermediateDirectories: true)
        NSWorkspace.shared.open(p)
    }
    @objc func changeToken() {
        let f = root.appendingPathComponent("config/update.json")
        var c = readJSON(f); c["token"] = ""; c["skipToken"] = false
        writeJSON(c, f)
        DispatchQueue.global().async { self.askTokenIfNeeded(f) }
    }
    @objc func checkUpdates() {
        DispatchQueue.global().async {
            let py = root.appendingPathComponent(".venv/bin/python").path
            let (_, out) = run(py, [root.appendingPathComponent("app/updater.py").path, "apply"])
            let updated = out.contains("\"updated\": true")
            if updated {
                run("/bin/bash", [root.appendingPathComponent("stop.sh").path])
                for _ in 0..<20 { if !serverUp() { break }; Thread.sleep(forTimeInterval: 0.25) }
                self.boot()
            }
            DispatchQueue.main.async {
                let a = NSAlert()
                if updated {
                    a.messageText = "Reel Studio se actualizó"
                } else if out.contains("No se pudo") || out.contains("no configuradas") {
                    a.messageText = "No se pudo buscar actualizaciones"
                    a.informativeText = out.trimmingCharacters(in: .whitespacesAndNewlines)
                } else {
                    a.messageText = "Ya tienes la última versión"
                }
                a.runModal()
            }
        }
    }

    // MARK: salir

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if let d = httpGet("/api/jobs"),
           let jobs = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]],
           jobs.contains(where: { ($0["kind"] as? String) == "export" || ($0["kind"] as? String) == "transcribe" }) {
            let a = NSAlert()
            a.messageText = "Hay un trabajo en curso"
            a.informativeText = "Reel Studio está exportando o transcribiendo. Si sales ahora, se cancela."
            a.addButton(withTitle: "Seguir trabajando")
            a.addButton(withTitle: "Salir igual")
            if a.runModal() == .alertFirstButtonReturn { return .terminateCancel }
        }
        if closing { return .terminateNow }
        closing = true
        // animación de cierre: el editor se despide y la ventana se desvanece
        web.evaluateJavaScript("window.rsClose && window.rsClose()", completionHandler: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) {
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.25
                self.window.animator().alphaValue = 0
            }, completionHandler: {
                DispatchQueue.global().async {
                    run("/bin/bash", [root.appendingPathComponent("stop.sh").path])
                    DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
                }
            })
        }
        return .terminateLater
    }

    // El botón rojo también cierra con la animación (la ventana sigue visible mientras tanto).
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closing { return true }
        NSApp.terminate(nil)
        return false
    }

    // MARK: WKUIDelegate — selector de archivos, alertas, enlaces externos

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let p = NSOpenPanel()
        p.canChooseFiles = true
        p.canChooseDirectories = false
        p.allowsMultipleSelection = parameters.allowsMultipleSelection
        p.beginSheetModal(for: window) { r in completionHandler(r == .OK ? p.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message
        a.addButton(withTitle: "Aceptar"); a.addButton(withTitle: "Cancelar")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = navigationAction.request.url { NSWorkspace.shared.open(u) }
        return nil
    }

    // MARK: WKNavigationDelegate — descargas y enlaces de fuera

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = navigationAction.request.url else { return decisionHandler(.allow) }
        if u.scheme == "about" || u.scheme == "data" { return decisionHandler(.allow) }
        if u.host != "localhost" && u.host != "127.0.0.1" {
            if navigationAction.navigationType == .linkActivated { NSWorkspace.shared.open(u) }
            return decisionHandler(navigationAction.navigationType == .linkActivated ? .cancel : .allow)
        }
        // "Descargar" una exportación: se copia a Descargas y se muestra en Finder.
        let parts = u.pathComponents   // ["/", "media", id, "export", archivo]
        if (u.query ?? "").contains("dl=1"), parts.count == 5, parts[1] == "media", parts[3] == "export" {
            let src = root.appendingPathComponent("proyectos/\(parts[2])/exports/\(parts[4])")
            let dl = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? home
            var dest = dl.appendingPathComponent(parts[4])
            var n = 2
            while FileManager.default.fileExists(atPath: dest.path) {
                let base = (parts[4] as NSString).deletingPathExtension, ext = (parts[4] as NSString).pathExtension
                dest = dl.appendingPathComponent("\(base) (\(n)).\(ext)"); n += 1
            }
            do {
                try FileManager.default.copyItem(at: src, to: dest)
                NSWorkspace.shared.activateFileViewerSelecting([dest])
            } catch {
                NSWorkspace.shared.activateFileViewerSelecting([src])
            }
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if webView.url?.host == "localhost" || (error as NSError).code == NSURLErrorCannotConnectToHost {
            show("Reel Studio se detuvo", "Volviendo a abrir…")
            DispatchQueue.global().async { Thread.sleep(forTimeInterval: 0.6); self.boot() }
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
