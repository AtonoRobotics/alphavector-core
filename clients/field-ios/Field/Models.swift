import Foundation

struct FieldJourneyKind: Codable, Identifiable, Hashable {
    var id: String
    var label: String
}

struct FieldJourneyRow: Codable, Identifiable, Hashable {
    var id: String
    var kind: String
    var objective: String
}

struct FieldRecordRow: Codable, Identifiable, Hashable {
    var id: String
    var type: String
    var label: String
    var attributes: [String: String]
}

struct FieldCard: Codable, Identifiable, Hashable {
    var cardId: String
    var purpose: String
    var subject: String
    var channel: String
    var approve: String
    var deny: String
    var id: String { cardId }
}

struct FieldOutbound: Codable, Identifiable, Hashable {
    var actionId: String
    var summary: String
    var id: String { actionId }
}

struct FieldHome: Codable {
    var journeys: [FieldJourneyRow]
    var inbox: [FieldCard]
    var outboundLog: [FieldOutbound]
    var journeyKinds: [FieldJourneyKind]
    var purposeFacts: [FieldJourneyKind]
    var avoidFacts: [FieldJourneyKind]
    var records: [FieldRecordRow]
    var recordKinds: [FieldJourneyKind]
}

struct FieldJourney: Codable {
    var id: String
    var journeyKind: String
    var objective: String
    var status: String
    var recordId: String?
}

struct FieldEffect: Codable {
    var actionId: String
    var executed: Bool
    var policyDecision: String
}

struct FieldProgressResult: Codable {
    var journey: FieldJourney
    var effect: FieldEffect?
}

struct FieldFactResult: Codable {
    var id: String
    var present: Bool
    var recordId: String?
}

struct FieldApproveResult: Codable {
    var card: FieldResolvedCard
    var journey: FieldJourney?
    var effect: FieldEffect?
    var fact: FieldFactResult?
    var record: FieldRecordRow?
}

struct FieldResolvedCard: Codable {
    var cardId: String
    var status: String
}

struct FieldAPIError: Codable {
    var error: String
    var message: String
    var cardId: String?
}

struct FieldProgressBody: Codable {
    var actionClass: String?
    var channel: String?
    var purpose: String?
    var subject: String?
    var note: String?
}

struct FieldRecordUpdateBody: Codable {
    var recordId: String
    var attributes: [String: String]
}

enum FieldClientError: Error, LocalizedError {
    case http(status: Int, code: String, message: String, cardId: String?)
    case decoding

    var errorDescription: String? {
        switch self {
        case let .http(_, _, message, _):
            return message
        case .decoding:
            return "Could not read the field response"
        }
    }

    var cardId: String? {
        if case let .http(_, _, _, cardId) = self { return cardId }
        return nil
    }

    var code: String? {
        if case let .http(_, code, _, _) = self { return code }
        return nil
    }
}
