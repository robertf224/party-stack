import CloudKit
import CoreLocation
import ExpoModulesCore
import Foundation
import UniformTypeIdentifiers

private enum PartyStackCloudKitBridgeError: LocalizedError {
  case invalidArgument(String)
  case conflict(String)
  case missingAssetFile

  var errorDescription: String? {
    switch self {
    case let .invalidArgument(message), let .conflict(message):
      return message
    case .missingAssetFile:
      return "CloudKit asset is missing its local file URL."
    }
  }
}

private let iso8601 = ISO8601DateFormatter()
let partyStackCloudKitChangeNotification = Notification.Name(
  "PartyStackCloudKitChange"
)
private let iso8601Fractional: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter
}()

private func parseISO8601(_ value: String) -> Date? {
  iso8601Fractional.date(from: value) ?? iso8601.date(from: value)
}

private func container(_ identifier: String) -> CKContainer {
  CKContainer(identifier: identifier)
}

private func database(
  _ container: CKContainer,
  scope: String
) throws -> CKDatabase {
  switch scope {
  case "private":
    return container.privateCloudDatabase
  case "public":
    return container.publicCloudDatabase
  case "shared":
    return container.sharedCloudDatabase
  default:
    throw PartyStackCloudKitBridgeError.invalidArgument(
      "Unknown CloudKit database scope \(scope)."
    )
  }
}

private func zoneID(_ value: [String: Any]) throws -> CKRecordZone.ID {
  guard let zoneName = value["zoneName"] as? String else {
    throw PartyStackCloudKitBridgeError.invalidArgument(
      "CloudKit zoneName is required."
    )
  }
  return CKRecordZone.ID(
    zoneName: zoneName,
    ownerName: value["ownerRecordName"] as? String ?? CKCurrentUserDefaultName
  )
}

private func location(
  _ containerIdentifier: String,
  _ value: [String: Any]
) throws -> (CKDatabase, CKRecordZone.ID) {
  guard
    let scope = value["databaseScope"] as? String,
    let zone = value["zone"] as? [String: Any]
  else {
    throw PartyStackCloudKitBridgeError.invalidArgument(
      "CloudKit location is invalid."
    )
  }
  return (
    try database(container(containerIdentifier), scope: scope),
    try zoneID(zone)
  )
}

private func zoneDictionary(_ zoneID: CKRecordZone.ID) -> [String: Any] {
  var result: [String: Any] = ["zoneName": zoneID.zoneName]
  if zoneID.ownerName != CKCurrentUserDefaultName {
    result["ownerRecordName"] = zoneID.ownerName
  }
  return result
}

private func reference(_ value: [String: Any]) throws -> CKRecord.Reference {
  guard let recordName = value["recordName"] as? String else {
    throw PartyStackCloudKitBridgeError.invalidArgument(
      "CloudKit reference recordName is required."
    )
  }
  let referenceZone = try (value["zone"] as? [String: Any]).map(zoneID)
  let recordID = CKRecord.ID(
    recordName: recordName,
    zoneID: referenceZone ?? CKRecordZone.default().zoneID
  )
  let action: CKRecord.ReferenceAction =
    value["action"] as? String == "deleteSelf" ? .deleteSelf : .none
  return CKRecord.Reference(recordID: recordID, action: action)
}

private func fieldValue(_ value: [String: Any]) throws -> CKRecordValue {
  guard let type = value["type"] as? String else {
    throw PartyStackCloudKitBridgeError.invalidArgument(
      "CloudKit field type is required."
    )
  }
  let raw = value["value"]
  switch type {
  case "string":
    return (raw as? String ?? "") as CKRecordValue
  case "int64":
    guard let string = raw as? String, let number = Int64(string) else {
      throw PartyStackCloudKitBridgeError.invalidArgument("Invalid int64 field.")
    }
    return NSNumber(value: number)
  case "double":
    return NSNumber(value: raw as? Double ?? 0)
  case "boolean":
    return NSNumber(value: raw as? Bool ?? false)
  case "date":
    guard let string = raw as? String, let date = parseISO8601(string) else {
      throw PartyStackCloudKitBridgeError.invalidArgument("Invalid date field.")
    }
    return date as CKRecordValue
  case "bytes":
    guard let string = raw as? String, let data = Data(base64Encoded: string) else {
      throw PartyStackCloudKitBridgeError.invalidArgument("Invalid bytes field.")
    }
    return data as CKRecordValue
  case "location":
    guard
      let dictionary = raw as? [String: Any],
      let latitude = dictionary["latitude"] as? Double,
      let longitude = dictionary["longitude"] as? Double
    else {
      throw PartyStackCloudKitBridgeError.invalidArgument("Invalid location field.")
    }
    let coordinate = CLLocationCoordinate2D(
      latitude: latitude,
      longitude: longitude
    )
    if dictionary.keys.contains(where: { $0 != "latitude" && $0 != "longitude" }) {
      return CLLocation(
        coordinate: coordinate,
        altitude: dictionary["altitude"] as? Double ?? 0,
        horizontalAccuracy: dictionary["horizontalAccuracy"] as? Double ?? -1,
        verticalAccuracy: dictionary["verticalAccuracy"] as? Double ?? -1,
        course: dictionary["course"] as? Double ?? -1,
        speed: dictionary["speed"] as? Double ?? -1,
        timestamp: (dictionary["timestamp"] as? String).flatMap(parseISO8601) ?? Date()
      )
    }
    return CLLocation(latitude: latitude, longitude: longitude)
  case "reference":
    guard let dictionary = raw as? [String: Any] else {
      throw PartyStackCloudKitBridgeError.invalidArgument("Invalid reference field.")
    }
    return try reference(dictionary)
  case "asset":
    guard
      let dictionary = raw as? [String: Any],
      let path = dictionary["fileURL"] as? String,
      let url = URL(string: path)
    else {
      throw PartyStackCloudKitBridgeError.missingAssetFile
    }
    return CKAsset(fileURL: url)
  case "list":
    guard let values = raw as? [[String: Any]] else {
      throw PartyStackCloudKitBridgeError.invalidArgument("Invalid list field.")
    }
    return try values.map(fieldValue) as CKRecordValue
  default:
    throw PartyStackCloudKitBridgeError.invalidArgument(
      "Unsupported CloudKit field type \(type)."
    )
  }
}

private func fieldDictionary(_ value: CKRecordValue) -> [String: Any] {
  if let values = value as? NSArray {
    let encoded: [[String: Any]] = values.map {
      fieldDictionary($0 as! CKRecordValue)
    }
    return [
      "type": "list",
      "value": encoded
    ]
  }
  if let asset = value as? CKAsset {
    return [
      "type": "asset",
      "value": [
        "fileURL": asset.fileURL?.absoluteString as Any
      ]
    ]
  }
  if let reference = value as? CKRecord.Reference {
    return [
      "type": "reference",
      "value": [
        "recordName": reference.recordID.recordName,
        "zone": zoneDictionary(reference.recordID.zoneID),
        "action": reference.action == .deleteSelf ? "deleteSelf" : "none"
      ]
    ]
  }
  if let date = value as? Date {
    return ["type": "date", "value": iso8601.string(from: date)]
  }
  if let data = value as? Data {
    return ["type": "bytes", "value": data.base64EncodedString()]
  }
  if let location = value as? CLLocation {
    return [
      "type": "location",
      "value": [
        "latitude": location.coordinate.latitude,
        "longitude": location.coordinate.longitude,
        "altitude": location.altitude,
        "horizontalAccuracy": location.horizontalAccuracy,
        "verticalAccuracy": location.verticalAccuracy,
        "course": location.course,
        "speed": location.speed,
        "timestamp": iso8601.string(from: location.timestamp)
      ]
    ]
  }
  if let string = value as? String {
    return ["type": "string", "value": string]
  }
  if let number = value as? NSNumber {
    if CFGetTypeID(number) == CFBooleanGetTypeID() {
      return ["type": "boolean", "value": number.boolValue]
    }
    if CFNumberIsFloatType(number) {
      return ["type": "double", "value": number.doubleValue]
    }
    return ["type": "int64", "value": number.stringValue]
  }
  return ["type": "string", "value": String(describing: value)]
}

private func recordDictionary(_ record: CKRecord) -> [String: Any] {
  var fields: [String: Any] = [:]
  for key in record.allKeys() {
    if let value = record[key] {
      fields[key] = fieldDictionary(value)
    }
  }
  var result: [String: Any] = [
    "recordName": record.recordID.recordName,
    "recordType": record.recordType,
    "fields": fields
  ]
  result["recordChangeTag"] = record.recordChangeTag
  result["createdTimestamp"] = record.creationDate.map(iso8601.string(from:))
  result["modifiedTimestamp"] = record.modificationDate.map(iso8601.string(from:))
  return result
}

private func applyFields(
  _ fields: [String: Any],
  to record: CKRecord
) throws {
  for (key, rawValue) in fields {
    guard let dictionary = rawValue as? [String: Any] else {
      throw PartyStackCloudKitBridgeError.invalidArgument(
        "CloudKit field \(key) is invalid."
      )
    }
    record[key] = try fieldValue(dictionary)
  }
}

private func archiveToken(_ token: CKServerChangeToken) throws -> String {
  try NSKeyedArchiver.archivedData(
    withRootObject: token,
    requiringSecureCoding: true
  ).base64EncodedString()
}

private func unarchiveToken(_ value: String?) throws -> CKServerChangeToken? {
  guard let value, let data = Data(base64Encoded: value) else {
    return nil
  }
  return try NSKeyedUnarchiver.unarchivedObject(
    ofClass: CKServerChangeToken.self,
    from: data
  )
}

private func fetchRecords(
  database: CKDatabase,
  recordIDs: [CKRecord.ID]
) async throws -> [String: CKRecord] {
  try await withCheckedThrowingContinuation { continuation in
    let operation = CKFetchRecordsOperation(recordIDs: recordIDs)
    var records: [String: CKRecord] = [:]
    var unexpectedErrors: [Error] = []
    operation.perRecordResultBlock = { recordID, result in
      switch result {
      case let .success(record):
        records[recordID.recordName] = record
      case let .failure(error):
        if (error as? CKError)?.code != .unknownItem {
          unexpectedErrors.append(error)
        }
      }
    }
    operation.fetchRecordsResultBlock = { result in
      switch result {
      case .success:
        continuation.resume(returning: records)
      case let .failure(error):
        if let unexpectedError = unexpectedErrors.first {
          continuation.resume(throwing: unexpectedError)
        } else if (error as? CKError)?.code == .partialFailure {
          continuation.resume(returning: records)
        } else {
          continuation.resume(throwing: error)
        }
      }
    }
    database.add(operation)
  }
}

private func modifyRecords(
  database: CKDatabase,
  saving: [CKRecord],
  deleting: [CKRecord.ID],
  atomic: Bool
) async throws -> ([CKRecord], [String]) {
  try await withCheckedThrowingContinuation { continuation in
    let operation = CKModifyRecordsOperation(
      recordsToSave: saving,
      recordIDsToDelete: deleting
    )
    operation.isAtomic = atomic
    operation.savePolicy = .ifServerRecordUnchanged
    var saved: [CKRecord] = []
    var deleted: [String] = []
    operation.perRecordSaveBlock = { _, result in
      if case let .success(record) = result {
        saved.append(record)
      }
    }
    operation.perRecordDeleteBlock = { recordID, result in
      if case .success = result {
        deleted.append(recordID.recordName)
      }
    }
    operation.modifyRecordsResultBlock = { result in
      switch result {
      case .success:
        continuation.resume(returning: (saved, deleted))
      case let .failure(error):
        continuation.resume(throwing: error)
      }
    }
    database.add(operation)
  }
}

public final class PartyStackCloudKitClientModule: Module {
  private var notificationObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("PartyStackCloudKitClient")
    Events("onCloudKitChange")

    OnCreate {
      notificationObserver = NotificationCenter.default.addObserver(
        forName: partyStackCloudKitChangeNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.sendEvent("onCloudKitChange")
      }
    }

    OnDestroy {
      if let notificationObserver {
        NotificationCenter.default.removeObserver(notificationObserver)
      }
      notificationObserver = nil
    }

    AsyncFunction("getAccountStatus") { (identifier: String) async -> String in
      let status = try? await container(identifier).accountStatus()
      switch status {
      case .available:
        return "available"
      case .noAccount:
        return "noAccount"
      case .restricted:
        return "restricted"
      default:
        return "couldNotDetermine"
      }
    }

    AsyncFunction("ensureZone") {
      (identifier: String, locationValue: [String: Any]) async throws in
      let (database, zoneID) = try location(identifier, locationValue)
      do {
        _ = try await database.save(CKRecordZone(zoneID: zoneID))
      } catch let error as CKError where error.code == .zoneNotFound {
        _ = try await database.save(CKRecordZone(zoneID: zoneID))
      } catch let error as CKError where error.code == .serverRejectedRequest {
        // Saving an existing zone is idempotent for this client.
      }
    }

    AsyncFunction("ensureSubscription") {
      (
        identifier: String,
        locationValue: [String: Any]
      ) async throws in
      let (database, zoneID) = try location(identifier, locationValue)
      let subscriptionID = [
        "party-stack",
        database.databaseScope == .private ? "private" : "shared",
        zoneID.ownerName,
        zoneID.zoneName
      ].joined(separator: ":")
      do {
        _ = try await database.subscription(for: subscriptionID)
      } catch let error as CKError where error.code == .unknownItem {
        let subscription = CKRecordZoneSubscription(
          zoneID: zoneID,
          subscriptionID: subscriptionID
        )
        let info = CKSubscription.NotificationInfo()
        info.shouldSendContentAvailable = true
        subscription.notificationInfo = info
        _ = try await database.save(subscription)
      }
      await MainActor.run {
        UIApplication.shared.registerForRemoteNotifications()
      }
    }

    AsyncFunction("fetchZones") {
      (identifier: String, scope: String) async throws -> [[String: Any]] in
      let database = try database(container(identifier), scope: scope)
      return try await database.allRecordZones().map {
        zoneDictionary($0.zoneID)
      }
    }

    AsyncFunction("fetchRecords") {
      (
        identifier: String,
        locationValue: [String: Any],
        recordNames: [String]
      ) async throws -> [[String: Any]] in
      let (database, zoneID) = try location(identifier, locationValue)
      let records = try await fetchRecords(
        database: database,
        recordIDs: recordNames.map {
          CKRecord.ID(recordName: $0, zoneID: zoneID)
        }
      )
      return recordNames.compactMap { records[$0] }.map(recordDictionary)
    }

    AsyncFunction("fetchZoneChanges") {
      (
        identifier: String,
        locationValue: [String: Any],
        cursor: String?,
        recordTypes: [String]?,
        limit: Int?
      ) async throws -> [String: Any] in
      let (database, zoneID) = try location(identifier, locationValue)
      let configuration = CKFetchRecordZoneChangesOperation.ZoneConfiguration()
      configuration.previousServerChangeToken = try unarchiveToken(cursor)
      configuration.resultsLimit = limit ?? CKQueryOperation.maximumResults
      configuration.desiredKeys = nil
      let operation = CKFetchRecordZoneChangesOperation(
        recordZoneIDs: [zoneID],
        configurationsByRecordZoneID: [zoneID: configuration]
      )
      var records: [[String: Any]] = []
      var deleted: [[String: Any]] = []
      var nextToken: CKServerChangeToken?
      var moreComing = false

      operation.recordWasChangedBlock = { _, result in
        if case let .success(record) = result,
           recordTypes == nil || recordTypes!.contains(record.recordType) {
          records.append(recordDictionary(record))
        }
      }
      operation.recordWithIDWasDeletedBlock = { recordID, recordType in
        if recordTypes == nil || recordTypes!.contains(recordType) {
          deleted.append([
            "recordName": recordID.recordName,
            "recordType": recordType
          ])
        }
      }

      return try await withCheckedThrowingContinuation { continuation in
        operation.recordZoneFetchResultBlock = { _, result in
          switch result {
          case let .success(value):
            nextToken = value.serverChangeToken
            moreComing = value.moreComing
          case let .failure(error):
            continuation.resume(throwing: error)
          }
        }
        operation.fetchRecordZoneChangesResultBlock = { result in
          switch result {
          case .success:
            do {
              guard let nextToken else {
                throw PartyStackCloudKitBridgeError.invalidArgument(
                  "CloudKit did not return a change token."
                )
              }
              continuation.resume(returning: [
                "records": records,
                "deleted": deleted,
                "cursor": try archiveToken(nextToken),
                "moreComing": moreComing
              ])
            } catch {
              continuation.resume(throwing: error)
            }
          case let .failure(error):
            continuation.resume(throwing: error)
          }
        }
        database.add(operation)
      }
    }

    AsyncFunction("modifyRecords") {
      (
        identifier: String,
        locationValue: [String: Any],
        operations: [[String: Any]],
        atomic: Bool
      ) async throws -> [String: Any] in
      let (database, zoneID) = try location(identifier, locationValue)
      let existingNames = operations.compactMap { operation -> String? in
        guard operation["type"] as? String != "create" else { return nil }
        if let name = operation["recordName"] as? String { return name }
        return (operation["record"] as? [String: Any])?["recordName"] as? String
      }
      let existing = try await fetchRecords(
        database: database,
        recordIDs: existingNames.map {
          CKRecord.ID(recordName: $0, zoneID: zoneID)
        }
      )
      var saving: [CKRecord] = []
      var deleting: [CKRecord.ID] = []

      for operation in operations {
        guard let type = operation["type"] as? String else {
          throw PartyStackCloudKitBridgeError.invalidArgument(
            "CloudKit operation type is required."
          )
        }
        if type == "delete" {
          guard
            let recordName = operation["recordName"] as? String,
            let changeTag = operation["recordChangeTag"] as? String,
            let record = existing[recordName]
          else {
            throw PartyStackCloudKitBridgeError.invalidArgument(
              "CloudKit delete operation is invalid."
            )
          }
          guard record.recordChangeTag == changeTag else {
            throw PartyStackCloudKitBridgeError.conflict(
              "CloudKit record \(recordName) changed."
            )
          }
          deleting.append(record.recordID)
          continue
        }

        guard
          let value = operation["record"] as? [String: Any],
          let recordName = value["recordName"] as? String,
          let recordType = value["recordType"] as? String,
          let fields = value["fields"] as? [String: Any]
        else {
          throw PartyStackCloudKitBridgeError.invalidArgument(
            "CloudKit save operation is invalid."
          )
        }
        let record: CKRecord
        if type == "create" {
          record = CKRecord(
            recordType: recordType,
            recordID: CKRecord.ID(recordName: recordName, zoneID: zoneID)
          )
        } else {
          guard
            let current = existing[recordName],
            current.recordChangeTag == value["recordChangeTag"] as? String
          else {
            throw PartyStackCloudKitBridgeError.conflict(
              "CloudKit record \(recordName) changed."
            )
          }
          record = current
          if type == "replace" {
            for key in record.allKeys() { record[key] = nil }
          }
        }
        try applyFields(fields, to: record)
        saving.append(record)
      }

      let result = try await modifyRecords(
        database: database,
        saving: saving,
        deleting: deleting,
        atomic: atomic
      )
      return [
        "records": result.0.map(recordDictionary),
        "deletedRecordNames": result.1
      ]
    }

    AsyncFunction("prepareAsset") {
      (base64: String, contentType: String) throws -> [String: Any] in
      guard let data = Data(base64Encoded: base64) else {
        throw PartyStackCloudKitBridgeError.invalidArgument(
          "Asset data is not valid base64."
        )
      }
      let extensionValue =
        UTType(mimeType: contentType)?.preferredFilenameExtension ?? "bin"
      let url = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString)
        .appendingPathExtension(extensionValue)
      try data.write(to: url, options: .atomic)
      return [
        "fileURL": url.absoluteString,
        "size": data.count
      ]
    }

    AsyncFunction("readAsset") {
      (asset: [String: Any]) throws -> [String: Any] in
      guard
        let path = asset["fileURL"] as? String,
        let url = URL(string: path)
      else {
        throw PartyStackCloudKitBridgeError.missingAssetFile
      }
      let data = try Data(contentsOf: url)
      return [
        "dataBase64": data.base64EncodedString(),
        "contentType": "application/octet-stream"
      ]
    }
  }
}
