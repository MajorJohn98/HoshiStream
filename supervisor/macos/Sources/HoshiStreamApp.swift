import AppKit
import Darwin
import IOKit.pwr_mgt
import ServiceManagement
import UniformTypeIdentifiers

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let status = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
    private let startItem = NSMenuItem(title: "Restart Server", action: #selector(restartServer), keyEquivalent: "r")
    private let speedItem = NSMenuItem(title: "Check Speed", action: #selector(checkSpeed), keyEquivalent: "s")
    private let loginItem = NSMenuItem(title: "Start at Login", action: #selector(toggleLogin), keyEquivalent: "")
    private var service: Process?
    private var healthTimer: Timer?
    private var pickerSocket: PickerSocket?
    private var restartCount = 0
    private var quitting = false
    private var sleepAssertion: IOPMAssertionID = 0
    private var sleepAssertionHeld = false

    // Resolved at runtime so the bundle is portable across machines. The
    // Info.plist key stays as a development override; the shipped build leaves
    // it at its placeholder and falls back to the per-user state directory.
    private var projectRoot: String {
        let override = Bundle.main.object(forInfoDictionaryKey: "HoshiStreamProjectRoot") as? String
        if let override, !override.isEmpty, override != "PROJECT_ROOT" { return override }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("HoshiStream").path
    }

    private func environmentValue(_ key: String) -> String? {
        guard let text = try? String(contentsOfFile: "\(projectRoot)/.env", encoding: .utf8) else { return nil }
        return text.split(whereSeparator: \.isNewline)
            .first { $0.hasPrefix("\(key)=") }
            .map { String($0.dropFirst(key.count + 1)) }
    }

    private var token: String? {
        environmentValue("ACCESS_TOKEN")
    }

    private var addonPort: Int {
        Int(environmentValue("ADDON_PORT") ?? "") ?? 7001
    }

    private func isPrivateIPv4(_ value: String) -> Bool {
        let parts = value.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4 else { return false }
        return parts[0] == 10 ||
            (parts[0] == 172 && 16...31 ~= parts[1]) ||
            (parts[0] == 192 && parts[1] == 168)
    }

    private var lanAddress: String? {
        var pointer: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&pointer) == 0, let first = pointer else { return nil }
        defer { freeifaddrs(pointer) }
        var addresses: [(name: String, address: String)] = []
        var current: UnsafeMutablePointer<ifaddrs>? = first
        while let interface = current {
            defer { current = interface.pointee.ifa_next }
            guard let socket = interface.pointee.ifa_addr,
                  socket.pointee.sa_family == UInt8(AF_INET),
                  interface.pointee.ifa_flags & UInt32(IFF_LOOPBACK) == 0
            else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(
                socket,
                socklen_t(socket.pointee.sa_len),
                &host,
                socklen_t(host.count),
                nil,
                0,
                NI_NUMERICHOST
            ) == 0 else { continue }
            let address = String(cString: host)
            guard isPrivateIPv4(address) else { continue }
            addresses.append((String(cString: interface.pointee.ifa_name), address))
        }
        return addresses.first { $0.name == "en0" }?.address ?? addresses.first?.address
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem.button?.image = NSImage(systemSymbolName: "sparkles.tv", accessibilityDescription: "HoshiStream")
        status.isEnabled = false
        startItem.target = self
        loginItem.target = self

        let menu = NSMenu()
        // Manual enablement so the speed item can disable itself mid-test.
        menu.autoenablesItems = false
        menu.addItem(status)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Open HoshiStream", action: #selector(openLibrary), keyEquivalent: "o").target = self
        menu.addItem(withTitle: "Copy Stremio URL", action: #selector(copyStremioURL), keyEquivalent: "c").target = self
        menu.addItem(startItem)
        speedItem.target = self
        menu.addItem(speedItem)
        menu.addItem(loginItem)
        menu.addItem(withTitle: "Show Logs", action: #selector(showLogs), keyEquivalent: "l").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit HoshiStream", action: #selector(quit), keyEquivalent: "q").target = self
        statusItem.menu = menu
        refreshLoginState()
        do {
            let socket = PickerSocket(path: "\(projectRoot)/run/supervisor.sock") {
                [weak self] kind, completion in
                self?.showPicker(kind, completion: completion)
            }
            try socket.start()
            pickerSocket = socket
        } catch {
            record("Finder service failed: \(error.localizedDescription)")
        }
        startServer()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.checkHealth()
        }
    }

    private func setStatus(_ title: String) {
        status.title = title
        statusItem.button?.toolTip = "HoshiStream — \(title)"
    }

    private func record(_ message: String) {
        NSLog("%@", message)
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/HoshiStream/server.log")
        guard let data = "\(message)\n".data(using: .utf8),
              let handle = try? FileHandle(forWritingTo: url)
        else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
    }

    private func startServer() {
        guard service == nil else { return }
        setStatus("Starting…")
        // Process.run() fails outright when the working directory is missing,
        // which is the normal state on a first launch.
        try? FileManager.default.createDirectory(
            at: URL(fileURLWithPath: projectRoot),
            withIntermediateDirectories: true
        )
        let resources = Bundle.main.resourceURL!.appendingPathComponent("runtime")
        let process = Process()
        process.executableURL = resources.appendingPathComponent("bin/node")
        process.arguments = [
            resources.appendingPathComponent("scripts/native-server.mjs").path,
            "--project-root=\(projectRoot)",
            "--state-dir=\(projectRoot)",
        ]
        process.currentDirectoryURL = URL(fileURLWithPath: projectRoot)
        let logURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/HoshiStream/server.log")
        try? FileManager.default.createDirectory(
            at: logURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        let log = try? FileHandle(forWritingTo: logURL)
        _ = try? log?.seekToEnd()
        process.standardOutput = log
        process.standardError = log
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self else { return }
                self.record("Daemon exited with status \(process.terminationStatus)")
                self.service = nil
                if self.quitting { return }
                if self.restartCount < 5 {
                    let delay = min(2.0 * pow(2.0, Double(self.restartCount)), 30.0)
                    self.restartCount += 1
                    self.setStatus("Recovering… (attempt \(self.restartCount))")
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { self.startServer() }
                } else {
                    self.setStatus("Error — see logs")
                }
            }
        }
        do {
            try process.run()
            service = process
        } catch {
            record("Daemon start failed: \(error.localizedDescription)")
            setStatus("Error — \(error.localizedDescription)")
        }
    }

    private func updateSleepAssertion(streaming: Bool) {
        if streaming, !sleepAssertionHeld {
            sleepAssertionHeld = IOPMAssertionCreateWithName(
                kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn),
                "HoshiStream playback" as CFString,
                &sleepAssertion
            ) == kIOReturnSuccess
        } else if !streaming, sleepAssertionHeld {
            IOPMAssertionRelease(sleepAssertion)
            sleepAssertionHeld = false
        }
    }

    private func checkHealth() {
        // On a first launch the server writes .env itself, so a missing token
        // is expected briefly rather than an error.
        guard let token else {
            return setStatus(service?.isRunning == true ? "Starting…" : "Error — missing access token")
        }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(addonPort)/api/status")!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let ready = (response as? HTTPURLResponse)?.statusCode == 200
            let summary = data.flatMap {
                try? JSONDecoder().decode(ServerStatus.self, from: $0)
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.updateSleepAssertion(streaming: ready && summary?.streamingActive == true)
                if ready {
                    self.restartCount = 0
                    self.setStatus(
                        summary.map {
                            "Ready • \($0.libraryCount) title\($0.libraryCount == 1 ? "" : "s") • \($0.homeSpeedMbps) Mbps"
                        } ?? "Ready"
                    )
                } else if self.service?.isRunning == true {
                    self.setStatus("Starting…")
                }
            }
        }.resume()
    }

    private func showPicker(_ kind: PickerKind, completion: @escaping (String?) -> Void) {
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = false
            panel.canChooseFiles = kind == .file
            panel.canChooseDirectories = kind == .folder
            panel.canCreateDirectories = false
            if kind == .file {
                panel.allowedContentTypes = ["mp4", "mkv", "webm", "avi", "mov", "m4v"]
                    .compactMap { UTType(filenameExtension: $0) }
            }
            panel.begin { response in
                completion(
                    response == .OK
                        ? panel.url?.resolvingSymlinksInPath().standardizedFileURL.path
                        : nil
                )
            }
        }
    }

    @objc private func checkSpeed() {
        guard let token else { return setStatus("Error — missing access token") }
        speedItem.isEnabled = false
        speedItem.title = "Measuring speed…"
        setStatus("Measuring connection speed…")
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(addonPort)/api/speedtest")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 30
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            let mbps = data.flatMap {
                try? JSONDecoder().decode(SpeedResult.self, from: $0)
            }?.mbps
            DispatchQueue.main.async {
                guard let self else { return }
                self.speedItem.isEnabled = true
                self.speedItem.title = ok
                    ? mbps.map { "Check Speed — \($0) Mbps just now" } ?? "Check Speed"
                    : "Check Speed — test failed"
                self.checkHealth()
            }
        }.resume()
    }

    @objc private func restartServer() {
        restartCount = 0
        if let service, service.isRunning {
            service.terminate()
        } else {
            startServer()
        }
    }

    @objc private func openLibrary() {
        guard let token,
              let escaped = token.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "http://127.0.0.1:\(addonPort)/manage/\(escaped)")
        else {
            setStatus("Error — missing access token")
            return
        }
        NSWorkspace.shared.open(url)
    }

    @objc private func copyStremioURL() {
        guard let token, let address = lanAddress,
              let escaped = token.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
        else {
            setStatus("Error — no private LAN address")
            return
        }
        let port = addonPort
        let value = "http://\(address):\(port)/addon/\(escaped)/manifest.json"
        guard let url = URL(string: value) else {
            setStatus("Error — invalid manifest URL")
            return
        }
        setStatus("Verifying Stremio URL…")
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let valid = (response as? HTTPURLResponse)?.statusCode == 200
                && data.flatMap {
                    try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
                }?["id"] as? String == "com.john.private-torrent-streamer"
            DispatchQueue.main.async {
                guard let self else { return }
                if valid {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(value, forType: .string)
                    self.setStatus("Verified Stremio URL copied")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                        self?.checkHealth()
                    }
                } else {
                    self.setStatus("Error — manifest not reachable")
                }
            }
        }.resume()
    }

    @objc private func showLogs() {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/HoshiStream/server.log")
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            setStatus("Login setting failed")
        }
        refreshLoginState()
    }

    private func refreshLoginState() {
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting { return .terminateLater }
        quitting = true
        healthTimer?.invalidate()
        pickerSocket?.stop()
        guard let service, service.isRunning else {
            return .terminateNow
        }
        service.terminate()
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(7)
            while service.isRunning && Date() < deadline { usleep(100_000) }
            if service.isRunning { kill(service.processIdentifier, SIGKILL) }
            DispatchQueue.main.async { sender.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }
}

private struct SpeedResult: Decodable {
    let mbps: Double
}

private struct ServerStatus: Decodable {
    let libraryCount: Int
    let homeSpeedMbps: Double
    let streamingActive: Bool?
}

@main
enum HoshiStreamMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) {
            app.run()
        }
    }
}
