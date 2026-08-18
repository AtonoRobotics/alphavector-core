import SwiftUI

private enum FieldGlass {
    static let bone = Color("Bone")
    static let nearBlack = Color("NearBlack")
    static let hairline = Color("Hairline")
    static let holdAmber = Color("HoldAmber")
}

struct HomeView: View {
    @StateObject private var api = FieldAPI()
    @State private var home: FieldHome?
    @State private var kind = ""
    @State private var objective = ""
    @State private var askText = "please read the file"
    @State private var askClass = "read"
    @State private var token = ""
    @State private var selectedRecordId = ""
    @State private var recordType = ""
    @State private var recordTypeCustom = ""
    @State private var recordLabel = ""
    @State private var attrKey = ""
    @State private var attrValue = ""
    @State private var factId = ""
    @State private var status = "Open a journey, then approve one card."
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                Section("Session") {
                    TextField("Issued field token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Load home") { Task { await refresh() } }
                }
                Section("Journeys") {
                    ForEach(home?.journeyKinds ?? []) { item in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(item.label).font(.headline)
                            Text(item.id).foregroundStyle(FieldGlass.hairline)
                            Button("Open") { Task { await openKind(item) } }
                        }
                    }
                    Picker("Journey", selection: $kind) {
                        ForEach(home?.journeyKinds ?? []) { item in
                            Text(item.label).tag(item.id)
                        }
                    }
                    TextField("Objective", text: $objective)
                    Button("Start journey") { Task { await startJourney() } }
                }
                Section("Started journeys") {
                    ForEach(home?.journeys ?? []) { journey in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(journey.kind).font(.headline)
                            Text(journey.objective).foregroundStyle(FieldGlass.hairline)
                            Button("Request follow-up") { Task { await requestFollowUp(journey) } }
                        }
                    }
                }
                Section("Records") {
                    ForEach(home?.records ?? []) { record in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(record.label).font(.headline)
                            Text("\(record.type) · \(record.id)").foregroundStyle(FieldGlass.hairline)
                            Text(attributePairs(record.attributes)).foregroundStyle(FieldGlass.hairline)
                            Button(record.id == selectedRecordId ? "Selected" : "Select") {
                                selectedRecordId = record.id
                                status = "Selected record \(record.id)"
                            }
                        }
                    }
                    Picker("Type", selection: $recordType) {
                        ForEach(home?.recordKinds ?? []) { item in
                            Text(item.label).tag(item.id)
                        }
                    }
                    TextField("Or type a label", text: $recordTypeCustom)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Record label", text: $recordLabel)
                    Button("Create record") { Task { await createRecord() } }
                    TextField("Attribute key", text: $attrKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Attribute value", text: $attrValue)
                    Button("Set attribute") { Task { await setAttribute() } }
                    Button("Retract record") { Task { await retractSelectedRecord() } }
                    ForEach(selectedAttributeRows) { row in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(row.key).font(.headline)
                            Text(row.value).foregroundStyle(FieldGlass.hairline)
                            Button("Retract") {
                                Task { await retractAttribute(row.key) }
                            }
                        }
                    }
                }
                Section("Purpose") {
                    ForEach(home?.purposeFacts ?? []) { item in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(item.label).font(.headline)
                            Text(item.id).foregroundStyle(FieldGlass.hairline)
                            Button("Record") { Task { await recordListedFact(item.id, before: "Select a record before recording a purpose") } }
                        }
                    }
                }
                Section("Avoids") {
                    ForEach(home?.avoidFacts ?? []) { item in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(item.label).font(.headline)
                            Text(item.id).foregroundStyle(FieldGlass.hairline)
                            HStack {
                                Button("Record") { Task { await recordListedFact(item.id, before: "Select a record before recording an avoid") } }
                                Button("Retract") { Task { await retractListedFact(item.id, before: "Select a record before retracting an avoid") } }
                            }
                        }
                    }
                }
                Section("Facts") {
                    TextField("Fact id", text: $factId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Record") { Task { await recordTypedFact() } }
                    Button("Retract") { Task { await retractTypedFact() } }
                }
                Section("Cards") {
                    ForEach(home?.inbox ?? []) { card in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(card.purpose).font(.headline).foregroundStyle(FieldGlass.holdAmber)
                            Text("\(card.subject) · \(card.channel)").foregroundStyle(FieldGlass.hairline)
                            HStack {
                                Button(card.approve) { Task { await approve(card) } }
                                Button(card.deny) { Task { await deny(card) } }
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
            .scrollContentBackground(.hidden)
            .background(FieldGlass.nearBlack)
            .foregroundStyle(FieldGlass.bone)
            .navigationTitle("Pyrallon Field")
            .toolbarBackground(FieldGlass.nearBlack, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .safeAreaInset(edge: .bottom) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(status)
                        .font(.footnote)
                    Text("Pyrallon")
                        .font(.footnote)
                }
                .foregroundStyle(FieldGlass.bone)
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(FieldGlass.nearBlack)
            }
            .disabled(busy)
        }
    }

    private var selectedRecord: FieldRecordRow? {
        home?.records.first(where: { $0.id == selectedRecordId })
    }

    private struct AttributeRow: Identifiable {
        var id: String { key }
        var key: String
        var value: String
    }

    private var selectedAttributeRows: [AttributeRow] {
        let attrs = selectedRecord?.attributes ?? [:]
        return attrs.keys.sorted().map { key in AttributeRow(key: key, value: attrs[key] ?? "") }
    }

    private func attributePairs(_ attributes: [String: String]) -> String {
        let rows = attributes.keys.sorted().map { key in "\(key)=\(attributes[key] ?? "")" }
        return rows.isEmpty ? "No attributes" : rows.joined(separator: " · ")
    }

    private func selectedRecordValue() -> String? {
        let id = selectedRecordId.trimmingCharacters(in: .whitespacesAndNewlines)
        return id.isEmpty ? nil : id
    }

    private func refresh() async {
        api.token = token
        await run {
            home = try await api.home()
            syncFromHome()
            status = "Field home loaded."
        }
    }

    private func syncFromHome() {
        if let first = home?.journeyKinds.first, home?.journeyKinds.contains(where: { $0.id == kind }) != true {
            kind = first.id
            if objective.isEmpty {
                objective = "Work this \(first.label) journey"
            }
        }
        if let first = home?.recordKinds.first, home?.recordKinds.contains(where: { $0.id == recordType }) != true {
            recordType = first.id
        }
        if selectedRecordId.isEmpty, let first = home?.records.first {
            selectedRecordId = first.id
        }
        if !selectedRecordId.isEmpty, home?.records.contains(where: { $0.id == selectedRecordId }) != true {
            selectedRecordId = home?.records.first?.id ?? ""
        }
    }

    private func startJourney() async {
        api.token = token
        guard let recordId = selectedRecordValue() else {
            status = "Select a record before starting"
            return
        }
        await run {
            let journey = try await api.start(journeyKind: kind, objective: objective, recordId: recordId)
            status = "Started \(journey.journeyKind)."
            home = try await api.home()
            syncFromHome()
        }
    }

    private func openKind(_ item: FieldJourneyKind) async {
        api.token = token
        guard let recordId = selectedRecordValue() else {
            status = "Select a record before opening"
            return
        }
        await issueCard {
            try await api.open(kindId: item.id, recordId: recordId)
        }
    }

    private func requestFollowUp(_ journey: FieldJourneyRow) async {
        api.token = token
        guard let recordId = selectedRecordValue() else {
            status = "Select a record before requesting follow-up"
            return
        }
        await issueCard {
            _ = try await api.progress(
                journeyId: journey.id,
                body: FieldProgressBody(
                    actionClass: "communicate",
                    channel: "email",
                    purpose: "follow-up",
                    subject: recordId
                )
            )
        }
    }

    private func createRecord() async {
        api.token = token
        let custom = recordTypeCustom.trimmingCharacters(in: .whitespacesAndNewlines)
        let type = custom.isEmpty ? recordType : custom
        await issueCard {
            try await api.create(type: type, label: recordLabel)
        }
    }

    private func setAttribute() async {
        api.token = token
        guard let recordId = selectedRecordValue() else {
            status = "Select a record before setting an attribute"
            return
        }
        let key = attrKey.trimmingCharacters(in: .whitespacesAndNewlines)
        await issueCard {
            try await api.update(recordId: recordId, attributes: [key: attrValue])
        }
    }

    private func retractAttribute(_ key: String) async {
        api.token = token
        guard let recordId = selectedRecordValue() else {
            status = "Select a record before retracting an attribute"
            return
        }
        await issueCard {
            try await api.retractAttribute(recordId: recordId, key: key)
        }
    }

    private func retractSelectedRecord() async {
        api.token = token
        guard let recordId = selectedRecordValue() else {
            status = "Select a record before retracting a record"
            return
        }
        await issueCard {
            try await api.retractRecord(recordId: recordId)
        }
    }

    private func recordListedFact(_ id: String, before: String) async {
        api.token = token
        guard let recordId = selectedRecordValue() else {
            status = before
            return
        }
        await issueCard {
            try await api.record(id: id, recordId: recordId)
        }
    }

    private func retractListedFact(_ id: String, before: String) async {
        api.token = token
        guard let recordId = selectedRecordValue() else {
            status = before
            return
        }
        await issueCard {
            try await api.retract(id: id, recordId: recordId)
        }
    }

    private func recordTypedFact() async {
        api.token = token
        guard let recordId = selectedRecordValue() else {
            status = "Select a record before recording a fact"
            return
        }
        await issueCard {
            try await api.record(id: factId.trimmingCharacters(in: .whitespacesAndNewlines), recordId: recordId)
        }
    }

    private func retractTypedFact() async {
        api.token = token
        guard let recordId = selectedRecordValue() else {
            status = "Select a record before retracting a fact"
            return
        }
        await issueCard {
            try await api.retract(id: factId.trimmingCharacters(in: .whitespacesAndNewlines), recordId: recordId)
        }
    }

    private func approve(_ card: FieldCard) async {
        api.token = token
        await run {
            let result = try await api.approve(cardId: card.cardId)
            if let created = result.record?.id {
                selectedRecordId = created
            }
            status = result.effect?.executed == true ? "Approved and executed." : "Approved."
            home = try await api.home()
            syncFromHome()
        }
    }

    private func deny(_ card: FieldCard) async {
        api.token = token
        await run {
            _ = try await api.deny(cardId: card.cardId)
            status = "Denied (terminal)."
            home = try await api.home()
            syncFromHome()
        }
    }

    private func sendAsk() async {
        api.token = token
        await run {
            try await api.ask(text: askText, actionClass: askClass)
            status = "Ask accepted."
        }
    }

    private func issueCard(_ work: () async throws -> Void) async {
        await run {
            do {
                try await work()
                status = "Completed without a card."
            } catch let error as FieldClientError {
                if error.cardId != nil {
                    status = "Card required."
                } else {
                    throw error
                }
            }
            home = try await api.home()
            syncFromHome()
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
