import SwiftUI

struct HomeView: View {
    @StateObject private var api = FieldAPI()
    @State private var home: FieldHome?
    @State private var kind = "buyer"
    @State private var objective = "Work this buyer journey"
    @State private var askText = "please read the file"
    @State private var askClass = "read"
    @State private var token = ""
    @State private var status = "Open a journey, then approve one card."
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                Section("Session") {
                    TextField("Field token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Load home") { Task { await refresh() } }
                }
                Section("Start a journey") {
                    Picker("Journey", selection: $kind) {
                        ForEach(home?.journeyKinds ?? [FieldJourneyKind(id: "buyer", label: "Buyer")]) { item in
                            Text(item.label).tag(item.id)
                        }
                    }
                    TextField("Objective", text: $objective)
                    Button("Start journey") { Task { await startJourney() } }
                }
                Section("Open journeys") {
                    ForEach(home?.journeys ?? []) { journey in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(journey.kind).font(.headline)
                            Text(journey.objective).foregroundStyle(.secondary)
                            Button("Request follow-up") { Task { await requestFollowUp(journey) } }
                        }
                    }
                }
                Section("Cards") {
                    ForEach(home?.inbox ?? []) { card in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(card.purpose).font(.headline)
                            Text("\(card.subject) · \(card.channel)").foregroundStyle(.secondary)
                            HStack {
                                Button(card.approve) { Task { await approve(card) } }
                                Button(card.deny, role: .destructive) { Task { await deny(card) } }
                            }
                        }
                    }
                }
                Section("Ask (optional)") {
                    TextField("Text", text: $askText)
                    TextField("Action class", text: $askClass)
                        .textInputAutocapitalization(.never)
                    Button("Send Ask") { Task { await sendAsk() } }
                }
                Section("Outbound") {
                    ForEach(home?.outboundLog ?? []) { row in
                        Text(row.summary)
                    }
                }
            }
            .navigationTitle("AV Dev Field")
            .safeAreaInset(edge: .bottom) {
                Text(status)
                    .font(.footnote)
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .disabled(busy)
        }
    }

    private func refresh() async {
        api.token = token
        await run {
            home = try await api.home()
            if let first = home?.journeyKinds.first, home?.journeyKinds.contains(where: { $0.id == kind }) != true {
                kind = first.id
            }
            status = "Field home loaded."
        }
    }

    private func startJourney() async {
        api.token = token
        await run {
            let journey = try await api.start(journeyKind: kind, objective: objective)
            status = "Started \(journey.journeyKind)."
            home = try await api.home()
        }
    }

    private func requestFollowUp(_ journey: FieldJourneyRow) async {
        api.token = token
        await run {
            do {
                _ = try await api.progress(
                    journeyId: journey.id,
                    body: FieldProgressBody(
                        actionClass: "communicate",
                        channel: "email",
                        purpose: "follow-up",
                        subject: journey.kind
                    )
                )
                status = "Progressed without a card."
            } catch let error as FieldClientError {
                if let cardId = error.cardId {
                    status = "Card required."
                    _ = cardId
                } else {
                    throw error
                }
            }
            home = try await api.home()
        }
    }

    private func approve(_ card: FieldCard) async {
        api.token = token
        await run {
            let result = try await api.approve(cardId: card.cardId)
            status = result.effect?.executed == true ? "Approved and executed." : "Approved."
            home = try await api.home()
        }
    }

    private func deny(_ card: FieldCard) async {
        api.token = token
        await run {
            _ = try await api.deny(cardId: card.cardId)
            status = "Denied (terminal)."
            home = try await api.home()
        }
    }

    private func sendAsk() async {
        api.token = token
        await run {
            try await api.ask(text: askText, actionClass: askClass)
            status = "Ask accepted."
        }
    }

    private func run(_ work: () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do {
            try await work()
        } catch {
            status = error.localizedDescription
        }
    }
}
