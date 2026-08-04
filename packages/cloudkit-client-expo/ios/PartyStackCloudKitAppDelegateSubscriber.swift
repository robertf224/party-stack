import CloudKit
import ExpoModulesCore
import UIKit

public final class PartyStackCloudKitAppDelegateSubscriber:
  ExpoAppDelegateSubscriber
{
  public func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (
      UIBackgroundFetchResult
    ) -> Void
  ) {
    guard
      CKNotification(
        fromRemoteNotificationDictionary: userInfo
      ) != nil
    else {
      completionHandler(.noData)
      return
    }
    NotificationCenter.default.post(
      name: partyStackCloudKitChangeNotification,
      object: nil
    )
    completionHandler(.newData)
  }
}
