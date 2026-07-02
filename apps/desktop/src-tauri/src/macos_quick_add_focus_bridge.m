#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

int mindwtr_macos_frontmost_application_pid(void) {
    @autoreleasepool {
        NSRunningApplication *frontmost = [[NSWorkspace sharedWorkspace] frontmostApplication];
        NSRunningApplication *current = [NSRunningApplication currentApplication];

        if (frontmost == nil || current == nil) {
            return 0;
        }

        pid_t frontmostPid = [frontmost processIdentifier];
        if (frontmostPid <= 0 || frontmostPid == [current processIdentifier]) {
            return 0;
        }

        return (int)frontmostPid;
    }
}

void mindwtr_macos_activate_application(int pid) {
    if (pid <= 0) {
        return;
    }

    dispatch_async(dispatch_get_main_queue(), ^{
        NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)pid];
        [application activateWithOptions:NSApplicationActivateIgnoringOtherApps];
    });
}
