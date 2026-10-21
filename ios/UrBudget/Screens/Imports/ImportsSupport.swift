import Foundation

/// A file the person picked, read into memory off the main thread.
struct ImportPickedFile: Sendable {
    var name: String
    var data: Data
}

/// Reading picked files with their security scope, inside the limits the shared engine sets.
enum ImportFiles {
    /// One file, refused when larger than `limit` bytes.
    static func read(_ url: URL, limit: Int, tooLarge: String) throws -> ImportPickedFile {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= limit else { throw AppError(tooLarge) }
        let data: Data
        do { data = try Data(contentsOf: url) } catch { throw AppError("The selected file could not be opened.") }
        guard data.count <= limit else { throw AppError(tooLarge) }
        return ImportPickedFile(name: url.lastPathComponent, data: data)
    }

    /// YNAB's export: at most eight files, 8 MB each and 16 MB together (ynab_files.rs).
    static func readYnab(_ urls: [URL]) throws -> [ImportPickedFile] {
        guard urls.count <= 8 else { throw AppError("Choose at most 8 export files at once.") }
        var total = 0
        return try urls.map { url in
            let file = try read(url, limit: 8 * 1024 * 1024,
                                tooLarge: "\(url.lastPathComponent) is larger than 8 MB. Use YNAB's token import for larger budgets.")
            total += file.data.count
            guard total <= 16 * 1024 * 1024 else {
                throw AppError("These export files total more than 16 MB. Use YNAB's token import for larger budgets.")
            }
            return file
        }
    }

    /// A bank statement's text: UTF-8 when it is, else Windows Latin, which many banks still write.
    static func text(_ data: Data) -> String {
        let bom = Data([0xEF, 0xBB, 0xBF])
        let body = data.starts(with: bom) ? data.dropFirst(3) : data
        return String(data: body, encoding: .utf8) ?? String(data: body, encoding: .windowsCP1252) ?? String(decoding: body, as: UTF8.self)
    }
}

/// Engine requests too large for the JSON value tree.
enum ImportsEngine {
    private static let digits: [[UInt8]] = (0...255).map { Array(String($0).utf8) }

    /// `importYnabFiles` takes each file as an array of byte values. Writing that request as text
    /// directly avoids building millions of JSON values on a phone.
    static func importYnabFiles(_ files: [ImportPickedFile], dateOrder: String, currency: String) throws -> JSON {
        var request = [UInt8]()
        request.reserveCapacity(files.reduce(256) { $0 + $1.data.count * 4 + $1.name.utf8.count })
        func append(_ text: String) { request.append(contentsOf: Array(text.utf8)) }
        append(#"{"version":1,"method":"importYnabFiles","params":{"files":["#)
        for (index, file) in files.enumerated() {
            if index > 0 { request.append(UInt8(ascii: ",")) }
            append(#"{"name":"#)
            append(JSON.string(file.name).serialized())
            append(#","bytes":["#)
            var first = true
            for byte in file.data {
                if !first { request.append(UInt8(ascii: ",")) }
                first = false
                request.append(contentsOf: digits[Int(byte)])
            }
            append("]}")
        }
        append(#"],"dateOrder":"#)
        append(dateOrder.isEmpty ? "null" : JSON.string(dateOrder).serialized())
        append(#","currency":"#)
        append(JSON.string(currency).serialized())
        append("}}")
        request.append(0)
        let reply: Data = request.withUnsafeBufferPointer { buffer in
            buffer.baseAddress!.withMemoryRebound(to: CChar.self, capacity: buffer.count) { pointer in
                guard let reply = urbudget_invoke(pointer) else { return Data(#"{"ok":false,"error":"The engine returned nothing."}"#.utf8) }
                defer { urbudget_free(reply) }
                return Data(bytes: reply, count: strlen(reply))
            }
        }
        let value = try JSON.parse(reply)
        guard value["ok"].bool else { throw AppError(value.text("error", "The shared engine couldn't read these files.")) }
        return value["value"]
    }
}

extension BudgetStore {
    /// An engine command from a review (`bankApply`), refused when the budget changed since the
    /// review was shown at `revision`. Runs in the edit queue, so nothing slips in between.
    func importsCommand(_ method: String, _ params: JSON, since revision: String, stale: String) async throws {
        try await perform { repository in
            guard await repository.revision == revision else { throw AppError(stale) }
            return ((), try await repository.command(method, params))
        }
    }

    /// Replaces the open budget with an imported one, refused when it changed since the preview.
    func importsReplace(with data: Data, since revision: String, stale: String) async throws {
        try await perform { repository in
            guard await repository.revision == revision else { throw AppError(stale) }
            return ((), try await repository.importBudget(data))
        }
    }
}
