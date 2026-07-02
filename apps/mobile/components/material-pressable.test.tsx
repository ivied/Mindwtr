import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import renderer from 'react-test-renderer';
import { Pressable, Text } from 'react-native';
import { MaterialPressable } from './material-pressable';

const tokenState = vi.hoisted(() => ({
  isMaterial: false,
  rippleColor: undefined as string | undefined,
}));

vi.mock('../hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({
    isMaterial: tokenState.isMaterial,
    state: {
      rippleColor: tokenState.rippleColor,
      stateLayerColor: () => (tokenState.isMaterial ? 'rgba(0, 0, 0, 0.1)' : 'transparent'),
    },
  }),
}));

const pressable = (tree: renderer.ReactTestRenderer) => tree.root.findByType(Pressable);

describe('MaterialPressable', () => {
  it('adds no android_ripple under non-Material themes', () => {
    tokenState.isMaterial = false;
    tokenState.rippleColor = undefined;
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <MaterialPressable>
          <Text>x</Text>
        </MaterialPressable>,
      );
    });
    expect(pressable(tree).props.android_ripple).toBeUndefined();
  });

  it('adds android_ripple under Material themes', () => {
    tokenState.isMaterial = true;
    tokenState.rippleColor = 'rgba(26, 28, 30, 0.1)';
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <MaterialPressable>
          <Text>x</Text>
        </MaterialPressable>,
      );
    });
    expect(pressable(tree).props.android_ripple).toEqual({ color: 'rgba(26, 28, 30, 0.1)' });
  });
});
