import { mock } from 'bun:test';
import React from 'react';

type NativeProps = Record<string, unknown> & { children?: React.ReactNode };

const createNativeComponent = (name: string) => {
    const Component = (props: NativeProps) => React.createElement(name, props, props.children);
    Component.displayName = name;
    return Component;
};

const addListener = () => ({ remove: () => undefined });

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

const Platform = {
    OS: 'ios',
    Version: 'test',
    select: <T,>(options: Partial<Record<'android' | 'ios' | 'default' | 'native' | 'web', T>>): T | undefined =>
        options.ios ?? options.default,
};

const createReactNativeMock = () => ({
    __esModule: true,
    ActivityIndicator: createNativeComponent('ActivityIndicator'),
    Alert: { alert: () => undefined },
    Animated: {
        Value: class {
            value: number;
            constructor(value = 0) {
                this.value = value;
            }
            setValue(value: number) {
                this.value = value;
            }
            interpolate() {
                return this;
            }
        },
        View: createNativeComponent('Animated.View'),
        createAnimatedComponent: (component: unknown) => component,
        timing: () => ({ start: (callback?: () => void) => callback?.() }),
        spring: () => ({ start: (callback?: () => void) => callback?.() }),
        parallel: () => ({ start: (callback?: () => void) => callback?.() }),
        sequence: () => ({ start: (callback?: () => void) => callback?.() }),
    },
    AppState: { addEventListener: addListener, currentState: 'active' },
    Appearance: { addChangeListener: addListener, getColorScheme: () => 'light' },
    Button: createNativeComponent('Button'),
    Dimensions: {
        addEventListener: addListener,
        get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
    },
    FlatList: createNativeComponent('FlatList'),
    Image: createNativeComponent('Image'),
    Keyboard: {
        addListener,
        dismiss: () => undefined,
    },
    KeyboardAvoidingView: createNativeComponent('KeyboardAvoidingView'),
    Linking: {
        addEventListener: addListener,
        canOpenURL: async () => true,
        openURL: async () => undefined,
    },
    Modal: createNativeComponent('Modal'),
    NativeModules: {},
    NativeEventEmitter: class {
        addListener() {
            return addListener();
        }

        removeAllListeners() {
            return undefined;
        }
    },
    PanResponder: {
        create: () => ({
            panHandlers: {},
        }),
    },
    Platform,
    Pressable: createNativeComponent('Pressable'),
    RefreshControl: createNativeComponent('RefreshControl'),
    SafeAreaView: createNativeComponent('SafeAreaView'),
    ScrollView: createNativeComponent('ScrollView'),
    SectionList: createNativeComponent('SectionList'),
    StatusBar: createNativeComponent('StatusBar'),
    StyleSheet: {
        absoluteFillObject: {},
        create: <T,>(styles: T): T => styles,
        flatten: (style: unknown) => style,
        hairlineWidth: 1,
    },
    Switch: createNativeComponent('Switch'),
    Text: createNativeComponent('Text'),
    TextInput: createNativeComponent('TextInput'),
    Touchable: {
        Mixin: {},
    },
    TouchableOpacity: createNativeComponent('TouchableOpacity'),
    TouchableWithoutFeedback: createNativeComponent('TouchableWithoutFeedback'),
    TurboModuleRegistry: {
        get: () => null,
        getEnforcing: () => ({}),
    },
    View: createNativeComponent('View'),
    findNodeHandle: () => 1,
    processColor: (color: unknown) => color,
    useColorScheme: () => 'light',
});

mock.module('react-native', createReactNativeMock);
mock.module(new URL('./node_modules/react-native/index.js', import.meta.url).pathname, createReactNativeMock);
mock.module(new URL('./apps/mobile/node_modules/react-native/index.js', import.meta.url).pathname, createReactNativeMock);

const createCodegenNativeComponentMock = () => ({
    __esModule: true,
    default: (name: string) => createNativeComponent(name),
});

mock.module('react-native/Libraries/Utilities/codegenNativeComponent', createCodegenNativeComponentMock);
mock.module(
    new URL('./node_modules/react-native/Libraries/Utilities/codegenNativeComponent.js', import.meta.url).pathname,
    createCodegenNativeComponentMock,
);
mock.module(
    new URL('./apps/mobile/node_modules/react-native/Libraries/Utilities/codegenNativeComponent.js', import.meta.url).pathname,
    createCodegenNativeComponentMock,
);
