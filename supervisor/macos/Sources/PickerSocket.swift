import Darwin
import Foundation

enum PickerKind: String {
    case file
    case folder
}

final class PickerSocket {
    typealias Selection = (PickerKind, @escaping (String?) -> Void) -> Void

    private let path: String
    private let selection: Selection
    private let clients = DispatchQueue(label: "com.hoshistream.picker")
    private var descriptor: Int32 = -1

    init(path: String, selection: @escaping Selection) {
        self.path = path
        self.selection = selection
    }

    func start() throws {
        let directory = URL(fileURLWithPath: path).deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        unlink(path)
        descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw POSIXError(.ENOTSOCK) }

        var address = sockaddr_un()
        let encoded = Array(path.utf8CString)
        guard encoded.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            throw POSIXError(.ENAMETOOLONG)
        }
        address.sun_family = sa_family_t(AF_UNIX)
        let length = socklen_t(MemoryLayout<sa_family_t>.size + encoded.count)
        address.sun_len = UInt8(length)
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            encoded.withUnsafeBytes { source in
                destination.copyBytes(from: source)
            }
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, length)
            }
        }
        guard bound == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        guard chmod(path, S_IRUSR | S_IWUSR) == 0 else { throw POSIXError(.EACCES) }
        guard listen(descriptor, 4) == 0 else { throw POSIXError(.EIO) }

        clients.async { [weak self] in
            guard let self else { return }
            while self.descriptor >= 0 {
                let client = accept(self.descriptor, nil, nil)
                if client >= 0 { self.handle(client) }
            }
        }
    }

    func stop() {
        guard descriptor >= 0 else { return }
        Darwin.close(descriptor)
        descriptor = -1
        unlink(path)
    }

    private func handle(_ client: Int32) {
        defer { Darwin.close(client) }
        var noSignal: Int32 = 1
        setsockopt(
            client,
            SOL_SOCKET,
            SO_NOSIGPIPE,
            &noSignal,
            socklen_t(MemoryLayout.size(ofValue: noSignal))
        )
        var buffer = [UInt8](repeating: 0, count: 8_192)
        let count = Darwin.read(client, &buffer, buffer.count)
        guard count > 0,
              let newline = buffer[..<count].firstIndex(of: 10),
              let request = try? JSONSerialization.jsonObject(
                with: Data(buffer[..<newline])
              ) as? [String: Any],
              let nonce = request["nonce"] as? String,
              let rawKind = request["kind"] as? String,
              let kind = PickerKind(rawValue: rawKind)
        else { return }

        let semaphore = DispatchSemaphore(value: 0)
        var selected: String?
        selection(kind) {
            selected = $0
            semaphore.signal()
        }
        semaphore.wait()
        let response: [String: Any] = selected.map {
            ["nonce": nonce, "path": $0]
        } ?? ["nonce": nonce, "cancelled": true]
        guard var data = try? JSONSerialization.data(withJSONObject: response) else { return }
        data.append(10)
        data.withUnsafeBytes { bytes in
            _ = Darwin.write(client, bytes.baseAddress, bytes.count)
        }
    }
}
