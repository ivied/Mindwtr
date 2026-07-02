import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import React from 'react';
import renderer from 'react-test-renderer';
import { Text, TextInput } from 'react-native';
import { describe, expect, it } from 'vitest';

import { CompactText, CompactTextInput } from './compact-text';

const flattenStyle = (style: unknown): Record<string, unknown> => {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
};

const mobileRoot = () => (
  process.cwd().endsWith('apps/mobile') ? process.cwd() : resolve(process.cwd(), 'apps/mobile')
);

const sourceFiles = (dir: string): string[] => {
  const entries = readdirSync(dir);
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [path];
  });
};

describe('CompactText', () => {
  it('caps compact labels by default while allowing explicit overrides', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<CompactText testID="label">Label</CompactText>);
    });
    const node = tree.root.findByType(Text);

    expect(node.props.maxFontSizeMultiplier).toBe(1.2);
    expect(flattenStyle(node.props.style).flexShrink).toBe(1);

    renderer.act(() => {
      tree.update(<CompactText testID="label" maxFontSizeMultiplier={1.1}>Label</CompactText>);
    });
    expect(tree.root.findByType(Text).props.maxFontSizeMultiplier).toBe(1.1);
  });

  it('caps compact text inputs by default', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<CompactTextInput testID="input" value="Task" onChangeText={() => {}} />);
    });

    expect(tree.root.findByType(TextInput).props.maxFontSizeMultiplier).toBe(1.2);
  });

  it('keeps app UI code from importing the compact scale directly', () => {
    const root = mobileRoot();
    const offenders = ['app', 'components']
      .flatMap((folder) => sourceFiles(join(root, folder)))
      .filter((path) => !path.endsWith(join('components', 'compact-text.tsx')))
      .filter((path) => readFileSync(path, 'utf8').includes('COMPACT_TEXT_MAX_SCALE'))
      .map((path) => relative(root, path));

    expect(offenders).toEqual([]);
  });
});
