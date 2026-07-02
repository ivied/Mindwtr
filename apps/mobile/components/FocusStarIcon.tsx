import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Star } from 'lucide-react-native';

export const FOCUS_STAR_COLOR = '#F59E0B';

type FocusStarIconProps = {
    disabled?: boolean;
    focused: boolean;
    inactiveColor: string;
    size?: number;
    style?: StyleProp<ViewStyle>;
};

export function FocusStarIcon({
    disabled = false,
    focused,
    inactiveColor,
    size = 22,
    style,
}: FocusStarIconProps) {
    return (
        <Star
            size={size}
            color={focused ? FOCUS_STAR_COLOR : inactiveColor}
            fill={focused ? FOCUS_STAR_COLOR : 'transparent'}
            strokeWidth={2}
            style={[
                style,
                { opacity: focused ? 1 : disabled ? 0.3 : 0.6 },
            ]}
        />
    );
}
