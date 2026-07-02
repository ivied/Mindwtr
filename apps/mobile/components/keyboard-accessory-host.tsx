import React from 'react';
import { StyleSheet, View } from 'react-native';

type KeyboardAccessoryHostValue = {
    mount: (key: string, node: React.ReactNode) => void;
    unmount: (key: string) => void;
};

const KeyboardAccessoryHostContext = React.createContext<KeyboardAccessoryHostValue | null>(null);
const activeHosts: KeyboardAccessoryHostValue[] = [];

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
    },
});

let nextPortalId = 0;

export function KeyboardAccessoryHost({
    backgroundColor,
    children,
}: {
    backgroundColor?: string;
    children: React.ReactNode;
}) {
    const [nodes, setNodes] = React.useState<Array<{ key: string; node: React.ReactNode }>>([]);

    const mount = React.useCallback((key: string, node: React.ReactNode) => {
        setNodes((current) => {
            const index = current.findIndex((entry) => entry.key === key);
            if (index === -1) {
                return [...current, { key, node }];
            }
            const next = [...current];
            next[index] = { key, node };
            return next;
        });
    }, []);

    const unmount = React.useCallback((key: string) => {
        setNodes((current) => current.filter((entry) => entry.key !== key));
    }, []);

    const value = React.useMemo(() => ({ mount, unmount }), [mount, unmount]);

    React.useEffect(() => {
        activeHosts.push(value);
        return () => {
            const index = activeHosts.lastIndexOf(value);
            if (index !== -1) activeHosts.splice(index, 1);
        };
    }, [value]);

    return (
        <KeyboardAccessoryHostContext.Provider value={value}>
            <View style={[styles.container, backgroundColor ? { backgroundColor } : null]}>
                {children}
                <View pointerEvents="box-none" style={styles.overlay}>
                    {nodes.map((entry) => (
                        <React.Fragment key={entry.key}>{entry.node}</React.Fragment>
                    ))}
                </View>
            </View>
        </KeyboardAccessoryHostContext.Provider>
    );
}

export function KeyboardAccessoryPortal({
    children,
    renderFallback = true,
}: {
    children: React.ReactNode;
    renderFallback?: boolean;
}) {
    const contextHost = React.useContext(KeyboardAccessoryHostContext);
    const activeHost = activeHosts[activeHosts.length - 1] ?? null;
    const host = contextHost ?? activeHost ?? null;
    const portalKeyRef = React.useRef(`keyboard-accessory-${nextPortalId++}`);

    React.useLayoutEffect(() => {
        if (!host) return;
        host.mount(portalKeyRef.current, children);
        return () => host.unmount(portalKeyRef.current);
    }, [children, host]);

    if (host) {
        return null;
    }

    return renderFallback ? <>{children}</> : null;
}
