import Foundation

/// Field HTTP client. Same routes as the Linux field client.
/// Locked field OS is SwiftUI iOS (DEC-009).
final class FieldAPI: ObservableObject {
    var baseURL: URL
    /// Tenant-issued field bearer token. Same Authorization header as the Linux client.
    var token: String

    init(baseURL: URL = URL(string: "http://127.0.0.1:8787")!, token: String = "") {
        self.baseURL = baseURL
        self.token = token
    }

    func home() async throws -> FieldHome {
        try await request(method: "GET", path: "/field/home")
    }

    func start(journeyKind: String, objective: String, recordId: String) async throws -> FieldJourney {
        try await request(
            method: "POST",
            path: "/field/journeys",
            body: ["journeyKind": journeyKind, "objective": objective, "recordId": recordId]
        )
    }

    func progress(journeyId: String, body: FieldProgressBody) async throws -> FieldProgressResult {
        try await request(method: "POST", path: "/field/journeys/\(journeyId)/progress", body: body)
    }

    func cards() async throws -> [FieldCard] {
        let envelope: CardsEnvelope = try await request(method: "GET", path: "/field/cards")
        return envelope.cards
    }

    func approve(cardId: String) async throws -> FieldApproveResult {
        try await request(method: "POST", path: "/field/cards/\(cardId)/approve")
    }

    func deny(cardId: String) async throws -> FieldResolvedCard {
        try await request(method: "POST", path: "/field/cards/\(cardId)/deny")
    }

    func ask(text: String, actionClass: String) async throws {
        let _: Ok = try await request(
            method: "POST",
            path: "/field/ask",
            body: ["text": text, "actionClass": actionClass]
        )
    }

    /// Continue is a wake. Field SHALL NOT pick who works.
    /// Takes no agent id, worker type, or assignee.
    func continueRun() async throws {
        let _: Ok = try await request(method: "POST", path: "/field/continue")
    }

    /// Issues an owner_instance card. Persist happens only after approve.
    func record(id: String, recordId: String) async throws {
        try await send(method: "POST", path: "/field/facts", body: ["id": id, "recordId": recordId])
    }

    /// Issues an owner_instance card. Retract happens only after approve.
    func retract(id: String, recordId: String) async throws {
        try await send(
            method: "POST",
            path: "/field/facts/retract",
            body: ["id": id, "recordId": recordId]
        )
    }

    /// Field Open: record `journey.{kindId}` on the subject record. Same path as Linux.
    func open(kindId: String, recordId: String) async throws {
        try await record(id: "journey.\(kindId)", recordId: recordId)
    }

    /// Issues an owner_instance card. Persist happens only after approve.
    func create(type: String, label: String) async throws {
        try await send(method: "POST", path: "/field/records", body: ["type": type, "label": label])
    }

    /// Issues an owner_instance card. Persist happens only after approve.
    func update(recordId: String, attributes: [String: String]) async throws {
        try await send(
            method: "POST",
            path: "/field/records/update",
            body: FieldRecordUpdateBody(recordId: recordId, attributes: attributes)
        )
    }

    /// Issues an owner_instance card. Persist happens only after approve.
    func retractAttribute(recordId: String, key: String) async throws {
        try await send(
            method: "POST",
            path: "/field/records/attributes/retract",
            body: ["recordId": recordId, "key": key]
        )
    }

    /// Issues an owner_instance card. Persist happens only after approve.
    func retractRecord(recordId: String) async throws {
        try await send(method: "POST", path: "/field/records/retract", body: ["recordId": recordId])
    }

    private struct CardsEnvelope: Codable { var cards: [FieldCard] }
    private struct Ok: Codable { var ok: Bool }

    private func request<T: Decodable>(method: String, path: String, body: Encodable? = nil) async throws -> T {
        let data = try await sendData(method: method, path: path, body: body)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw FieldClientError.decoding
        }
    }

    private func send(method: String, path: String, body: Encodable? = nil) async throws {
        _ = try await sendData(method: method, path: path, body: body)
    }

    private func sendData(method: String, path: String, body: Encodable? = nil) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw FieldClientError.decoding
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status >= 400 {
            let parsed = try? JSONDecoder().decode(FieldAPIError.self, from: data)
            throw FieldClientError.http(
                status: status,
                code: parsed?.error ?? "HTTP_ERROR",
                message: parsed?.message ?? "Field request failed",
                cardId: parsed?.cardId
            )
        }
        return data
    }
}

private struct AnyEncodable: Encodable {
    private let encodeClosure: (Encoder) throws -> Void
    init(_ value: Encodable) {
        encodeClosure = { encoder in try value.encode(to: encoder) }
    }
    func encode(to encoder: Encoder) throws { try encodeClosure(encoder) }
}
