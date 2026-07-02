import { describe, expect, it } from 'vitest';

const plugin = require('./patch-alarm-notification-gradle');

const {
  applyGradleCompatPatchToSource,
  applyAlarmPendingIntentPatchToSource,
  applyAlarmDuplicateToastPatchToSource,
  applyAlarmTimingPatchToSource,
  applyAlarmReminderBehaviorPatchToSource,
  applyAlarmAudioInterfacePatchToSource,
  applyAlarmDismissReceiverPatchToSource,
  applyAlarmReceiverPatchToSource,
  applyAlarmCompleteConstantsPatchToSource,
  applyAlarmTaskOpenIntentPatchToSource,
  applyAlarmCompleteUtilPatchToSource,
  applyAlarmCompleteReceiverPatchToSource,
  applyAlarmIosCompleteActionPatchToSource,
} = plugin.__testables;

describe('patch-alarm-notification-gradle', () => {
  it('patches AlarmUtil pending intent flags for Android 12+', () => {
    const input = `class AlarmUtil {
    private NotificationManager getNotificationManager() {
        return null;
    }

    void demo(Context context, Intent intent, int id) {
        PendingIntent.getBroadcast(context, id, intent, 0);
        PendingIntent.getActivity(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT);
    }
}`;

    const output = applyAlarmPendingIntentPatchToSource(input);

    expect(output).toContain('private int getImmutableFlag()');
    expect(output).toContain('PendingIntent.getBroadcast(context, id, intent, getImmutableFlag())');
    expect(output).toContain('PendingIntent.getActivity(context, id, intent, getUpdateCurrentImmutableFlags())');
  });

  it('removes the native duplicate alarm toast so JS retries stay silent', () => {
    const input = `    boolean checkAlarm(ArrayList<AlarmModel> alarms, AlarmModel alarm) {
        boolean contain = false;

        if (contain) {
            Toast.makeText(mContext, "You have already set this Alarm", Toast.LENGTH_SHORT).show();
        }

        return contain;
    }`;

    const output = applyAlarmDuplicateToastPatchToSource(input);

    expect(output).not.toContain('Toast.makeText');
    expect(output).toContain('Duplicate alarms are reported to JS via promise rejection');
    expect(output).toContain('return contain;');
  });

  it('patches Android task reminder timing for exact delivery and sane snooze', () => {
    const input = `class AlarmUtil {
    private AlarmManager getAlarmManager() {
        return (AlarmManager) mContext.getSystemService(Context.ALARM_SERVICE);
    }

    void setAlarm(Alarm alarm, AlarmManager alarmManager, Calendar calendar, PendingIntent alarmIntent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), alarmIntent);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            alarmManager.setExact(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), alarmIntent);
        } else {
            alarmManager.set(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), alarmIntent);
        }
    }

    void snoozeAlarm(AlarmModel alarm) {
        Calendar calendar = getCalendarFromAlarm(alarm);

        this.stopAlarmSound();

        calendar.add(Calendar.MINUTE, alarm.getSnoozeInterval());

        setAlarmFromCalendar(alarm, calendar);

        long time = System.currentTimeMillis() / 1000;

        alarm.setAlarmId((int) time);

        getAlarmDB().update(alarm);

        Log.e(TAG, "snooze data - " + alarm.toString());
    }
}`;

    const output = applyAlarmTimingPatchToSource(input);

    expect(output).toContain('private void setExactOrAllowWhileIdle');
    expect(output).toContain('alarmManager.canScheduleExactAlarms()');
    expect(output).toContain('alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, alarmIntent);');
    expect(output).toContain('alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, alarmIntent);');
    expect(output).toContain('setExactOrAllowWhileIdle(alarmManager, calendar.getTimeInMillis(), alarmIntent);');
    expect(output).not.toContain('alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), alarmIntent);');
    expect(output).toContain('Calendar calendar = Calendar.getInstance();');
    expect(output).not.toContain('Calendar calendar = getCalendarFromAlarm(alarm);');
    expect(output).toContain('int firedNotificationId = alarm.getAlarmId();');
    expect(output).toContain('getNotificationManager().cancel(firedNotificationId);');
    expect(output.indexOf('int firedNotificationId = alarm.getAlarmId();')).toBeLessThan(output.indexOf('alarm.setAlarmId((int) time);'));
    // Snooze schedules an independent alarm row so the JS reschedule cycle cannot reap it.
    expect(output).toContain('int snoozedAlarmRowId = getAlarmDB().insert(alarm);');
    expect(output).toContain('alarm.setId(snoozedAlarmRowId);');
    expect(output).not.toContain('getAlarmDB().update(alarm);');
    expect(output.indexOf('getNotificationManager().cancel(firedNotificationId);')).toBeGreaterThan(output.indexOf('int snoozedAlarmRowId = getAlarmDB().insert(alarm);'));
  });

  it('patches AlarmUtil reminder behavior away from alarm semantics', () => {
    const input = `class AlarmUtil {
    void init() {
        uri = Settings.System.DEFAULT_ALARM_ALERT_URI;
    }

    void send(Alarm alarm, NotificationCompat.Builder builder, Vibrator vibrator) {
        boolean playSound = alarm.isPlaySound();
        if (playSound) {
            this.playAlarmSound(alarm.getSoundName(), alarm.getSoundNames(), alarm.isLoopSound(), alarm.getVolume());
        }
        NotificationChannel mChannel = new NotificationChannel(channelID, "Alarm Notify", NotificationManager.IMPORTANCE_HIGH);
                mChannel.setVibrationPattern(null);

                // play vibration
                if (alarm.isVibrate()) {
                    Vibrator vibrator = (Vibrator) mContext.getSystemService(Context.VIBRATOR_SERVICE);
                    if (vibrator.hasVibrator()) {
                        vibrator.vibrate(VibrationEffect.createWaveform(vibrationPattern, 0));
                    }
                }
        builder.setPriority(NotificationCompat.PRIORITY_MAX);
        builder.setCategory(NotificationCompat.CATEGORY_ALARM);
        builder.setSound(null);
    }
}`;

    const output = applyAlarmReminderBehaviorPatchToSource(input);

    expect(output).toContain('Settings.System.DEFAULT_NOTIFICATION_URI');
    expect(output).not.toContain('this.playAlarmSound(');
    expect(output).toContain('NotificationManager.IMPORTANCE_DEFAULT');
    expect(output).toContain('NotificationCompat.PRIORITY_DEFAULT');
    expect(output).toContain('NotificationCompat.CATEGORY_REMINDER');
    expect(output).toContain('.setSound(playSound ? android.provider.Settings.System.DEFAULT_NOTIFICATION_URI : null)');
    expect(output).toContain('mChannel.enableVibration(alarm.isVibrate());');
    expect(output).toContain('mChannel.setSound(playSound ? android.provider.Settings.System.DEFAULT_NOTIFICATION_URI : null, null);');
  });

  it('patches AudioInterface fallback sound away from the alarm tone', () => {
    const input = `class AudioInterface {
    void init(Context context) {
        uri = Settings.System.DEFAULT_ALARM_ALERT_URI;
    }
}`;

    const output = applyAlarmAudioInterfacePatchToSource(input);

    expect(output).toContain('Settings.System.DEFAULT_NOTIFICATION_URI');
    expect(output).not.toContain('Settings.System.DEFAULT_ALARM_ALERT_URI');
  });

  it('patches dismiss receiver to cancel alarms even without a React context', () => {
    const input = `        try {
            if (ANModule.getReactAppContext() != null) {
                int notificationId = intent.getExtras().getInt(Constants.DISMISSED_NOTIFICATION_ID);
                ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationDismissed", "{\\"id\\": \\"" + notificationId + "\\"}");

                alarmUtil.removeFiredNotification(notificationId);

                alarmUtil.doCancelAlarm(notificationId);
            }
        } catch (Exception e) {`;

    const output = applyAlarmDismissReceiverPatchToSource(input);

    expect(output).not.toContain('if (ANModule.getReactAppContext() != null) {\n                int notificationId');
    expect(output).toContain('int notificationId = intent.getExtras().getInt(Constants.DISMISSED_NOTIFICATION_ID);');
    expect(output).toContain('alarmUtil.doCancelAlarm(notificationId);');
    expect(output).toContain('alarmUtil.stopAlarmSound();');
  });

  it('guards dismiss event emission when the React context is missing', () => {
    const input = `                            // emit notification dismissed
                            ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationDismissed", "{\\"id\\": \\"" + alarm.getId() + "\\"}");
`;

    const output = applyAlarmReceiverPatchToSource(input);

    expect(output).toContain('if (ANModule.getReactAppContext() != null) {');
    expect(output).toContain('emit("OnNotificationDismissed"');
  });

  it('adds an Android complete notification action from task reminder data', () => {
    const constants = applyAlarmCompleteConstantsPatchToSource(`class Constants {
    static final String NOTIFICATION_ACTION_SNOOZE = "ACTION_SNOOZE";
}`);
    expect(constants).toContain('NOTIFICATION_ACTION_COMPLETE');

    const openIntent = applyAlarmTaskOpenIntentPatchToSource(`import android.media.MediaPlayer;
class AlarmUtil {
    void send(Alarm alarm, Bundle bundle, Intent intent, Context mContext, int notificationID) {
            PendingIntent pendingIntent = PendingIntent.getActivity(mContext, notificationID, intent, getUpdateCurrentImmutableFlags());
    }
}`);
    expect(openIntent).toContain('import android.net.Uri;');
    expect(openIntent).toContain('String taskId = bundle.getString("taskId")');
    expect(openIntent).toContain('intent.setAction(Intent.ACTION_VIEW)');
    expect(openIntent).toContain('Uri.parse("mindwtr:///focus")');
    expect(openIntent).toContain('.appendQueryParameter("taskId", taskId)');
    expect(openIntent).toContain('.appendQueryParameter("taskTab", "view")');

    const util = applyAlarmCompleteUtilPatchToSource(`import static com.emekalites.react.alarm.notification.Constants.NOTIFICATION_ACTION_DISMISS;
import static com.emekalites.react.alarm.notification.Constants.NOTIFICATION_ACTION_SNOOZE;
class AlarmUtil {
    void send(Alarm alarm, Bundle bundle, NotificationCompat.Builder mBuilder, Context mContext, int notificationID) {
            if (alarm.isHasButton()) {
                Intent dismissIntent = new Intent(mContext, AlarmReceiver.class);
                dismissIntent.setAction(NOTIFICATION_ACTION_DISMISS);
                dismissIntent.putExtra("AlarmId", alarm.getId());
                PendingIntent pendingDismiss = PendingIntent.getBroadcast(mContext, notificationID, dismissIntent, getUpdateCurrentImmutableFlags());
                NotificationCompat.Action dismissAction = new NotificationCompat.Action(android.R.drawable.ic_lock_idle_alarm, "DISMISS", pendingDismiss);
                mBuilder.addAction(dismissAction);

                Intent snoozeIntent = new Intent(mContext, AlarmReceiver.class);
                snoozeIntent.setAction(NOTIFICATION_ACTION_SNOOZE);
                snoozeIntent.putExtra("SnoozeAlarmId", alarm.getId());
                PendingIntent pendingSnooze = PendingIntent.getBroadcast(mContext, notificationID, snoozeIntent, getUpdateCurrentImmutableFlags());
                NotificationCompat.Action snoozeAction = new NotificationCompat.Action(R.drawable.ic_snooze, "SNOOZE", pendingSnooze);
                mBuilder.addAction(snoozeAction);
            }
    }
}`);
    expect(util).toContain('NOTIFICATION_ACTION_COMPLETE');
    expect(util).toContain('notificationActionComplete');
    expect(util).toContain('"COMPLETE"');

    const receiver = applyAlarmCompleteReceiverPatchToSource(`import android.content.Intent;
class AlarmReceiver {
    void onReceive(Context context, Intent intent) {
                switch (action) {
                    case Constants.NOTIFICATION_ACTION_DISMISS:
                        id = intent.getExtras().getInt("AlarmId");
                }
    }
}`);
    expect(receiver).toContain('case Constants.NOTIFICATION_ACTION_COMPLETE');
    expect(receiver).toContain('payload.putString("actionIdentifier", "complete")');
    expect(receiver).toContain('NotificationOpenPayloadStore.cache(pendingPayload)');
    expect(receiver).toContain('emit("OnNotificationOpened"');
  });

  it('adds iOS complete actions and exposes pending action payloads', () => {
    const input = `#import "RnAlarmNotification.h"

static NSString *const kLocalNotificationReceived = @"LocalNotificationReceived";
static id _sharedInstance = nil;

API_AVAILABLE(ios(10.0))
static NSDictionary *RCTFormatUNNotification(UNNotification *notification) {
    NSMutableDictionary *formattedNotification = [NSMutableDictionary dictionary];
    UNNotificationContent *content = notification.request.content;

    formattedNotification[@"id"] = notification.request.identifier;
    formattedNotification[@"data"] = RCTNullIfNil([content.userInfo objectForKey:@"data"]);

    return formattedNotification;
}

static NSDateComponents *parseDate(NSString *dateString) {
    return nil;
}

static NSString *stringify(NSDictionary *notification) {
    return @"{}";
}

@implementation RnAlarmNotification

RCT_EXPORT_MODULE(RNAlarmNotification);

+ (void)didReceiveNotificationResponse:(UNNotificationResponse *)response
API_AVAILABLE(ios(10.0)) {
    NSLog(@"show notification");
    [[UIApplication sharedApplication] setIdleTimerDisabled:NO];
    if ([response.notification.request.content.categoryIdentifier isEqualToString:@"CUSTOM_ACTIONS"]) {
       if ([response.actionIdentifier isEqualToString:@"SNOOZE_ACTION"]) {
           [RnAlarmNotification snoozeAlarm:response.notification];
       } else if ([response.actionIdentifier isEqualToString:@"DISMISS_ACTION"]) {
           NSLog(@"do dismiss");
           [RnAlarmNotification stopSound];

           NSMutableDictionary *notification = [NSMutableDictionary dictionary];
           notification[@"id"] = response.notification.request.identifier;

           [[NSNotificationCenter defaultCenter] postNotificationName:kLocalNotificationDismissed
                                                               object:self
                                                             userInfo:notification];
       }
    }

    // send notification
    [[NSNotificationCenter defaultCenter] postNotificationName:kLocalNotificationReceived
                                                        object:self
                                                      userInfo:RCTFormatUNNotification(response.notification)];
}

- (void)startObserving {
}

- (void)demo {
            if([details[@"has_button"] isEqualToNumber: [NSNumber numberWithInt: 1]]){
                content.categoryIdentifier = @"CUSTOM_ACTIONS";
            }
            content.userInfo = @{
                @"has_button": details[@"has_button"],
                @"schedule_type": details[@"schedule_type"]
            };

        UNNotificationAction* snoozeAction = [UNNotificationAction
              actionWithIdentifier:@"SNOOZE_ACTION"
              title:@"SNOOZE"
              options:UNNotificationActionOptionNone];

        UNNotificationAction* stopAction = [UNNotificationAction
              actionWithIdentifier:@"DISMISS_ACTION"
              title:@"DISMISS"
              options:UNNotificationActionOptionForeground];

        UNNotificationCategory* customCategory = [UNNotificationCategory
            categoryWithIdentifier:@"CUSTOM_ACTIONS"
            actions:@[snoozeAction, stopAction]
            intentIdentifiers:@[]
            options:UNNotificationCategoryOptionNone];
}

@end`;

    const output = applyAlarmIosCompleteActionPatchToSource(input);

    expect(output).toContain('RCTFormatUNNotificationWithAction');
    expect(output).toContain('consumePendingNotificationOpenPayload');
    expect(output).toContain('actionWithIdentifier:@"COMPLETE_ACTION"');
    expect(output).toContain('cachePendingNotificationOpenPayload(formattedNotification)');
    expect(output).toContain('@"has_complete_action": details[@"has_complete_action"]');
  });

  it('keeps the Gradle compatibility rewrite in place', () => {
    const input = `apply plugin: 'maven'
buildscript {
  dependencies {
    classpath 'com.android.tools.build:gradle:3.4.1'
  }
}

android {
  compileSdkVersion safeExtGet('compileSdkVersion', DEFAULT_COMPILE_SDK_VERSION)
}

dependencies {
    //noinspection GradleDynamicVersion
    implementation 'com.facebook.react:react-native:+'  // From node_modules
    implementation 'com.google.code.gson:gson:2.8.6'
}

afterEvaluate { project ->
  // legacy publishing tasks
}`;

    const output = applyGradleCompatPatchToSource(input);

    expect(output).not.toContain("apply plugin: 'maven'");
    expect(output).toContain("compileSdk safeExtGet('compileSdkVersion', DEFAULT_COMPILE_SDK_VERSION)");
    expect(output).not.toContain('afterEvaluate { project ->');
    expect(output.slice(0, output.indexOf('android {'))).not.toContain('notification-open-intents');
    expect(output).toContain("classpath 'com.android.tools.build:gradle:3.4.1'");
    expect(output).toContain("implementation project(':notification-open-intents')");
    expect(output.indexOf("classpath 'com.android.tools.build:gradle:3.4.1'")).toBeLessThan(output.indexOf("implementation project(':notification-open-intents')"));
    expect(applyGradleCompatPatchToSource(output).match(/notification-open-intents/g)).toHaveLength(2);
  });
});
