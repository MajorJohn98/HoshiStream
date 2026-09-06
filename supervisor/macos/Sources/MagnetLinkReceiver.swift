import Foundation

// URL events may arrive before the local server starts. Only metadata is handed
// off here; the management page still requires an explicit Add confirmation.
final class MagnetLinkReceiver {
    private struct Pending {
        let magnet: String
        let deadline: Date
    }
    private struct Ticket: Decodable {
        let id: UUID
        let expiresAt: String
    }

    private var pending: [Pending] = []
    private var sending = false
    private var ready = false
    private let credentials: () -> (port: Int, token: String)?
    private let openReview: (String) -> Bool
    private let reportError: (String) -> Void

    init(
        credentials: @escaping () -> (port: Int, token: String)?,
        openReview: @escaping (String) -> Bool,
        reportError: @escaping (String) -> Void
    ) {
        self.credentials = credentials
        self.openReview = openReview
        self.reportError = reportError
    }

    func receive(_ urls: [URL]) {
        var rejected = false
        for url in urls {
            guard url.scheme?.lowercased() == "magnet",
                  url.absoluteString.utf8.count <= 16_384,
                  url.host == nil, url.fragment == nil,
                  let colon = url.absoluteString.firstIndex(of: ":")
            else {
                rejected = true
                continue
            }
            let magnet = "magnet" + url.absoluteString[colon...]
            if pending.contains(where: { $0.magnet == magnet }) { continue }
            guard pending.count < 16 else {
                rejected = true
                continue
            }
            pending.append(Pending(magnet: magnet, deadline: Date().addingTimeInterval(60)))
        }
        if rejected {
            reportError("Some links were invalid or too many arrived at once. Use a BitTorrent v1 magnet link and open one at a time.")
        }
        pump(serverReady: ready)
    }

    func pump(serverReady: Bool) {
        ready = serverReady
        guard !sending, !pending.isEmpty else { return }
        let expired = pending.contains { $0.deadline <= Date() }
        pending.removeAll { $0.deadline <= Date() }
        if expired {
            reportError("HoshiStream could not start in time to open the magnet link. Wait for the app to be ready, then click the original link again.")
        }
        guard ready, let item = pending.first, let settings = credentials() else { return }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(settings.port)/api/imports/magnet-links")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("Bearer \(settings.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            request.httpBody = try JSONEncoder().encode(["magnetUri": item.magnet])
        } catch {
            pending.removeFirst()
            reportError("The magnet link could not be prepared. Paste it into Add Media instead.")
            pump(serverReady: ready)
            return
        }
        sending = true
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode
            let ticket = data.flatMap { $0.count <= 4096 ? try? JSONDecoder().decode(Ticket.self, from: $0) : nil }
            DispatchQueue.main.async {
                guard let self else { return }
                self.sending = false
                self.pending.removeFirst()
                if status == 200, let ticket {
                    if !self.openReview(ticket.id.uuidString.lowercased()) {
                        self.reportError("The browser could not open Add Media. Open HoshiStream and paste the magnet link manually.")
                    }
                } else {
                    self.reportError(status == 400
                        ? "This magnet link is invalid or unsupported. Choose a BitTorrent v1 magnet link."
                        : "The local app could not open the magnet link for review. Click the original link again once HoshiStream is ready.")
                }
                self.pump(serverReady: self.ready)
            }
        }.resume()
    }
}
