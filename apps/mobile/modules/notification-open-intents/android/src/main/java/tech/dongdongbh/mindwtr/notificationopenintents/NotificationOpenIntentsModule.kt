package tech.dongdongbh.mindwtr.notificationopenintents

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NotificationOpenIntentsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NotificationOpenIntents")

    Function("consumePendingOpenPayload") {
      NotificationOpenPayloadStore.consume()
    }
  }
}
