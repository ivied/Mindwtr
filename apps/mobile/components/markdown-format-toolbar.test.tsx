import React from 'react';
import { Dimensions, Keyboard, Platform, Pressable, ScrollView } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MARKDOWN_TOOLBAR_ACTIONS } from '@mindwtr/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KeyboardAccessoryHost } from './keyboard-accessory-host';
import { MarkdownFormatToolbar } from './markdown-format-toolbar';

vi.mock('@expo/vector-icons', () => ({
    FontAwesome: (props: any) => React.createElement('FontAwesome', props),
    Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

const themeColors = {
    bg: '#ffffff',
    cardBg: '#ffffff',
    taskItemBg: '#ffffff',
    inputBg: '#ffffff',
    filterBg: '#f2f2f7',
    border: '#d1d5db',
    text: '#111827',
    secondaryText: '#6b7280',
    icon: '#6b7280',
    tint: '#2563eb',
    onTint: '#ffffff',
    tabIconDefault: '#6b7280',
    tabIconSelected: '#2563eb',
    danger: '#dc2626',
    success: '#16a34a',
    warning: '#d97706',
};

const baseProps = {
    selection: { start: 0, end: 0 },
    onSelectionChange: vi.fn(),
    inputRef: { current: null },
    t: (key: string) => key,
    tc: themeColors,
    visible: true,
    canUndo: false,
    onUndo: vi.fn(),
    onApplyAction: vi.fn(() => ({ value: '', selection: { start: 0, end: 0 } })),
};

const originalPlatformOs = Platform.OS;
const originalKeyboardMetrics = Keyboard.metrics;

const setPlatform = (os: typeof Platform.OS) => {
    Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: os,
    });
};

const extractFloatingBarBottom = (tree: ReactTestRenderer) => {
    const toolbarBars = tree.root.findAll((node) => (
        Array.isArray(node.props.style)
        && node.props.style.some((entry: Record<string, unknown> | null) => (
            entry && typeof entry === 'object' && 'bottom' in entry
        ))
    ));
    const styleWithBottom = toolbarBars[0]?.props.style.find((entry: Record<string, unknown> | null) => (
        entry && typeof entry === 'object' && 'bottom' in entry
    ));
    return styleWithBottom?.bottom;
};

const layoutKeyboardToolbarOverlay = (tree: ReactTestRenderer, height: number, width = 390) => {
    const toolbarOverlay = tree.root.findAll((node) => (
        node.props.pointerEvents === 'box-none'
        && typeof node.props.onLayout === 'function'
        && node.props.style?.justifyContent === 'flex-end'
    ))[0];
    expect(toolbarOverlay).toBeDefined();

    act(() => {
        toolbarOverlay.props.onLayout({
            nativeEvent: {
                layout: {
                    x: 0,
                    y: 0,
                    width,
                    height,
                },
            },
        });
    });
};

const renderKeyboardToolbar = (props: Partial<React.ComponentProps<typeof MarkdownFormatToolbar>> = {}) => (
    <KeyboardAccessoryHost>
        <MarkdownFormatToolbar {...baseProps} {...props} />
    </KeyboardAccessoryHost>
);

describe('MarkdownFormatToolbar', () => {
    afterEach(() => {
        Object.defineProperty(Platform, 'OS', {
            configurable: true,
            value: originalPlatformOs,
        });
        Object.defineProperty(Keyboard, 'metrics', {
            configurable: true,
            value: originalKeyboardMetrics,
        });
        vi.restoreAllMocks();
    });

    it('renders inline without waiting for keyboard metrics', () => {
        let tree: ReactTestRenderer | undefined;
        act(() => {
            tree = create(<MarkdownFormatToolbar {...baseProps} placement="inline" />);
        });

        expect(tree!.root.findAllByType(Pressable)).toHaveLength(MARKDOWN_TOOLBAR_ACTIONS.length + 1);
    });

    it('keeps toolbar buttons at the compact touch-safe minimum when actions overflow phone width', () => {
        let tree: ReactTestRenderer | undefined;
        act(() => {
            tree = create(<MarkdownFormatToolbar {...baseProps} placement="inline" />);
        });

        const firstAction = tree!.root.findAllByType(Pressable)[0];
        const styles = firstAction.props.style({ pressed: false });
        const adaptiveStyle = styles.find((entry: Record<string, unknown> | null) => entry && entry.width);

        expect(adaptiveStyle).toEqual(expect.objectContaining({
            width: 32,
            minHeight: 32,
            minWidth: 32,
        }));
    });

    it('uses a vector italic icon instead of Android italic text rendering', () => {
        let tree: ReactTestRenderer | undefined;
        act(() => {
            tree = create(<MarkdownFormatToolbar {...baseProps} placement="inline" />);
        });

        const italicIcons = tree!.root.findAll((node) => (
            String(node.type) === 'FontAwesome' && node.props.name === 'italic'
        ));

        expect(italicIcons).toHaveLength(1);
        expect(italicIcons[0].props.size).toBe(12);
    });

    it('renders vector icons for added Markdown toolbar actions', () => {
        let tree: ReactTestRenderer;
        act(() => {
            tree = create(<MarkdownFormatToolbar {...baseProps} placement="inline" />);
        });

        const strikethroughIcons = tree!.root.findAll((node) => (
            String(node.type) === 'FontAwesome' && node.props.name === 'strikethrough'
        ));
        const codeBlockIcons = tree!.root.findAll((node) => (
            String(node.type) === 'Ionicons' && node.props.name === 'code-working-outline'
        ));
        const horizontalRuleIcons = tree!.root.findAll((node) => (
            String(node.type) === 'Ionicons' && node.props.name === 'remove-outline'
        ));

        expect(strikethroughIcons).toHaveLength(1);
        expect(codeBlockIcons).toHaveLength(1);
        expect(horizontalRuleIcons).toHaveLength(1);
    });

    it('waits for keyboard visibility before rendering keyboard placement', () => {
        const listeners = new Map<string, (event?: unknown) => void>();
        vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: unknown) => void) => {
            listeners.set(eventName, listener);
            return { remove: () => listeners.delete(eventName) };
        }) as any);

        let tree: ReactTestRenderer | undefined;
        act(() => {
            tree = create(renderKeyboardToolbar());
        });

        expect(tree!.root.findAllByType(Pressable)).toHaveLength(0);

        act(() => {
            listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 320, screenY: 524 } });
        });

        expect(tree!.root.findAllByType(Pressable)).toHaveLength(0);

        layoutKeyboardToolbarOverlay(tree!, 844);

        expect(tree!.root.findAllByType(Pressable)).toHaveLength(MARKDOWN_TOOLBAR_ACTIONS.length + 1);
    });

    it('hides keyboard placement again when the keyboard is dismissed', () => {
        const listeners = new Map<string, (event?: unknown) => void>();
        vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: unknown) => void) => {
            listeners.set(eventName, listener);
            return { remove: () => listeners.delete(eventName) };
        }) as any);

        let tree: ReactTestRenderer | undefined;
        act(() => {
            tree = create(renderKeyboardToolbar());
        });

        act(() => {
            listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 320, screenY: 524 } });
        });
        layoutKeyboardToolbarOverlay(tree!, 844);

        expect(tree!.root.findAllByType(Pressable)).toHaveLength(MARKDOWN_TOOLBAR_ACTIONS.length + 1);

        act(() => {
            listeners.get('keyboardDidHide')?.();
        });

        expect(tree!.root.findAllByType(Pressable)).toHaveLength(0);
    });

    it('uses the keyboard height on Android when the release window is not resized', () => {
        setPlatform('android');
        vi.spyOn(Dimensions, 'get').mockReturnValue({
            width: 390,
            height: 844,
            scale: 3,
            fontScale: 1,
        });
        const listeners = new Map<string, (event?: unknown) => void>();
        vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: unknown) => void) => {
            listeners.set(eventName, listener);
            return { remove: () => listeners.delete(eventName) };
        }) as any);

        let tree: ReactTestRenderer | undefined;
        act(() => {
            tree = create(renderKeyboardToolbar());
        });

        act(() => {
            listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 320, screenY: 524 } });
        });

        expect(tree!.root.findAllByType(Pressable)).toHaveLength(0);
        layoutKeyboardToolbarOverlay(tree!, 844);

        expect(extractFloatingBarBottom(tree!)).toBe(320);
    });

    it('uses Android keyboard event geometry instead of a stale small metrics inset', () => {
        setPlatform('android');
        vi.spyOn(Dimensions, 'get').mockReturnValue({
            width: 390,
            height: 844,
            scale: 3,
            fontScale: 1,
        });
        Object.defineProperty(Keyboard, 'metrics', {
            configurable: true,
            value: vi.fn(() => ({ height: 44, screenY: 800 })),
        });
        const listeners = new Map<string, (event?: unknown) => void>();
        vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: unknown) => void) => {
            listeners.set(eventName, listener);
            return { remove: () => listeners.delete(eventName) };
        }) as any);

        let tree: ReactTestRenderer | undefined;
        act(() => {
            tree = create(renderKeyboardToolbar());
        });

        act(() => {
            listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 320, screenY: 524 } });
        });
        layoutKeyboardToolbarOverlay(tree!, 844);

        expect(extractFloatingBarBottom(tree!)).toBe(320);
    });

    it('does not lift Android toolbar for small metrics-only keyboard insets', () => {
        setPlatform('android');
        vi.spyOn(Dimensions, 'get').mockReturnValue({
            width: 390,
            height: 524,
            scale: 3,
            fontScale: 1,
        });
        Object.defineProperty(Keyboard, 'metrics', {
            configurable: true,
            value: vi.fn(() => ({ height: 72, screenY: 772 })),
        });
        vi.spyOn(Keyboard, 'addListener').mockImplementation(((_eventName: string, _listener: (event?: unknown) => void) => {
            return { remove: () => undefined };
        }) as any);

        let tree: ReactTestRenderer | undefined;
        act(() => {
            tree = create(renderKeyboardToolbar());
        });
        layoutKeyboardToolbarOverlay(tree!, 524);

        expect(extractFloatingBarBottom(tree!)).toBe(0);
    });

    it('moves Android toolbar back to the resized overlay edge when layout shrinks after keyboard show', () => {
        setPlatform('android');
        vi.spyOn(Dimensions, 'get').mockImplementation(((dimension: string) => ({
            width: 360,
            height: dimension === 'window' ? 792 : 792,
            scale: 3,
            fontScale: 1,
        })) as any);
        const listeners = new Map<string, (event?: unknown) => void>();
        vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: unknown) => void) => {
            listeners.set(eventName, listener);
            return { remove: () => listeners.delete(eventName) };
        }) as any);

        let tree: ReactTestRenderer | undefined;
        act(() => {
            tree = create(renderKeyboardToolbar());
        });

        act(() => {
            listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 255, screenY: 521 } });
        });

        expect(tree!.root.findAllByType(Pressable)).toHaveLength(0);
        layoutKeyboardToolbarOverlay(tree!, 481, 360);

        expect(extractFloatingBarBottom(tree!)).toBe(0);
    });

    it('keeps Android toolbar at the resized window edge when the root is already above the keyboard', () => {
        setPlatform('android');
        let windowHeight = 844;
        vi.spyOn(Dimensions, 'get').mockImplementation(((dimension: string) => ({
            width: 390,
            height: dimension === 'window' ? windowHeight : 844,
            scale: 3,
            fontScale: 1,
        })) as any);
        const listeners = new Map<string, (event?: unknown) => void>();
        vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: unknown) => void) => {
            listeners.set(eventName, listener);
            return { remove: () => listeners.delete(eventName) };
        }) as any);

        let tree: ReactTestRenderer | undefined;
        act(() => {
            tree = create(renderKeyboardToolbar());
        });

        windowHeight = 524;
        act(() => {
            listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 320, screenY: 524 } });
        });

        layoutKeyboardToolbarOverlay(tree!, 524);

        expect(extractFloatingBarBottom(tree!)).toBe(0);
    });

    it('keeps Android toolbar at the resized window edge when mounted after the keyboard opens', () => {
        setPlatform('android');
        vi.spyOn(Dimensions, 'get').mockImplementation(((dimension: string) => ({
            width: 390,
            height: dimension === 'window' ? 524 : 844,
            scale: 3,
            fontScale: 1,
        })) as any);
        const listeners = new Map<string, (event?: unknown) => void>();
        vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: unknown) => void) => {
            listeners.set(eventName, listener);
            return { remove: () => listeners.delete(eventName) };
        }) as any);

        let tree: ReactTestRenderer | undefined;
        act(() => {
            tree = create(renderKeyboardToolbar());
        });

        act(() => {
            listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 320, screenY: 524 } });
        });

        layoutKeyboardToolbarOverlay(tree!, 524);

        expect(extractFloatingBarBottom(tree!)).toBe(0);
    });

    it('applies toolbar actions on tap release so horizontal drags do not format text', () => {
        const onApplyAction = vi.fn(() => ({ value: '', selection: { start: 0, end: 0 } }));
        let tree: ReactTestRenderer | undefined;
        act(() => {
            tree = create(<MarkdownFormatToolbar {...baseProps} onApplyAction={onApplyAction} placement="inline" />);
        });

        const firstAction = tree!.root.findAllByType(Pressable)[0];

        act(() => {
            firstAction.props.onPressIn();
        });
        expect(onApplyAction).not.toHaveBeenCalled();

        act(() => {
            firstAction.props.onPress();
        });
        expect(onApplyAction).toHaveBeenCalledTimes(1);
    });

    it('ignores toolbar button release while the horizontal action strip is scrolling', () => {
        const onApplyAction = vi.fn(() => ({ value: '', selection: { start: 0, end: 0 } }));
        let tree: ReactTestRenderer | undefined;
        act(() => {
            tree = create(<MarkdownFormatToolbar {...baseProps} onApplyAction={onApplyAction} placement="inline" />);
        });

        const actionStrip = tree!.root.findByType(ScrollView);
        const firstAction = tree!.root.findAllByType(Pressable)[0];

        act(() => {
            actionStrip.props.onScrollBeginDrag();
            firstAction.props.onPress();
        });

        expect(onApplyAction).not.toHaveBeenCalled();
    });
});
