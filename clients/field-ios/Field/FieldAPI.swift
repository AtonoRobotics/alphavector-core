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

    func start(journeyKind: String, objective: String) async throws -> FieldJourney {
        try await request(
            method: "POST",
            path: "/field/journeys",
            body: ["journeyKind": journeyKind, "objective": objective]
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

    private struct CardsEnvelope: Codable { var cards: [FieldCard] }
    private struct Ok: Codable { var ok: Bool }

    private func request<T: Decodable>(method: String, path: String, body: Encodable? = nil) async throws -> T {
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
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw FieldClientError.decoding
        }
    }
}

private struct AnyEncodable: Encodable {
    private let encodeClosure: (Encoder) throws -> Void
    init(_ value: Encodable) {
        encodeClosure = { encoder in try value.encode(to: encoder) }
    }
    func encode(to encoder: Encoder) throws { try encodeClosure(encoder) }
}
