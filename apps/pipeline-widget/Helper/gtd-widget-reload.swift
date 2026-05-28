// Standalone CLI that asks WidgetKit to refresh our widget timelines.
// Built as a separate binary so non-Swift processes (capture-agent, scripts)
// can trigger near-real-time widget updates without bundling Swift glue.
//
// Build: swiftc -O -o gtd-widget-reload gtd-widget-reload.swift
// Use:   /path/to/gtd-widget-reload [kind]
//        (no arg = reload all; "PipelineWidget" = just this widget's kind)

import WidgetKit

let args = CommandLine.arguments
if args.count > 1 {
    WidgetCenter.shared.reloadTimelines(ofKind: args[1])
} else {
    WidgetCenter.shared.reloadAllTimelines()
}

// reloadAllTimelines is fire-and-forget but WidgetKit needs the run loop alive
// briefly to deliver the XPC message before we exit.
RunLoop.current.run(until: Date().addingTimeInterval(0.2))
