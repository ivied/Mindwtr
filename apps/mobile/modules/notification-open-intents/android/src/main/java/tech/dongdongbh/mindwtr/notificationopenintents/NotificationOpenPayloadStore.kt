package tech.dongdongbh.mindwtr.notificationopenintents

object NotificationOpenPayloadStore {
  @Volatile
  private var pendingNotificationOpenPayload: LinkedHashMap<String, String>? = null

  fun cache(payload: Map<String, String>) {
    pendingNotificationOpenPayload = LinkedHashMap(payload)
  }

  fun consume(): LinkedHashMap<String, String>? {
    val payload = pendingNotificationOpenPayload ?: return null
    pendingNotificationOpenPayload = null
    return LinkedHashMap(payload)
  }
}
