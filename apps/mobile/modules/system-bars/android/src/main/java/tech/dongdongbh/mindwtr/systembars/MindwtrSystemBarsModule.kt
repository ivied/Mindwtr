package tech.dongdongbh.mindwtr.systembars

import android.graphics.Color
import android.os.Build
import android.view.View
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MindwtrSystemBarsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MindwtrSystemBars")

    AsyncFunction("setNavigationBarColorAsync") { color: String, darkButtons: Boolean ->
      setNavigationBarColor(color, darkButtons)
    }.runOnQueue(Queues.MAIN)
  }

  @Suppress("DEPRECATION")
  private fun setNavigationBarColor(color: String, darkButtons: Boolean): Boolean {
    val activity = appContext.currentActivity ?: return false
    val window = activity.window
    window.navigationBarColor = Color.parseColor(color)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val decorView = window.decorView
      val currentFlags = decorView.systemUiVisibility
      decorView.systemUiVisibility = if (darkButtons) {
        currentFlags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
      } else {
        currentFlags and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
      }
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      window.isNavigationBarContrastEnforced = false
    }

    return true
  }
}
