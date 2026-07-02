package tech.dongdongbh.mindwtr.notificationopenintents

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.graphics.Color
import android.media.AudioAttributes
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NotificationOpenIntentsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NotificationOpenIntents")

    Function("consumePendingOpenPayload") {
      NotificationOpenPayloadStore.consume()
    }

    Function("ensureReminderChannel") { channelId: String, channelName: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        return@Function
      }

      val context = appContext.reactContext ?: return@Function
      val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        ?: return@Function
      val existingChannel = notificationManager.getNotificationChannel(channelId)
      if (existingChannel != null) {
        return@Function
      }

      val channel = NotificationChannel(
        channelId,
        channelName,
        NotificationManager.IMPORTANCE_DEFAULT
      )
      val audioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

      channel.description = channelName
      channel.enableLights(true)
      channel.lightColor = Color.parseColor("#3b82f6")
      channel.enableVibration(false)
      channel.setSound(Settings.System.DEFAULT_NOTIFICATION_URI, audioAttributes)

      notificationManager.createNotificationChannel(channel)
    }
  }
}
