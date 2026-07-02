import { describe, expect, it } from 'vitest';

import { styles } from './settings.styles';

const flattenStyle = (value: any): Record<string, unknown> => (
  Array.isArray(value)
    ? Object.assign({}, ...value.map(flattenStyle))
    : value
);

describe('settings styles', () => {
  it('lets setting rows and right-side values wrap instead of truncating labels', () => {
    expect(flattenStyle(styles.settingRow)).toMatchObject({
      alignItems: 'flex-start',
    });
    expect(flattenStyle(styles.settingInfo)).toMatchObject({
      minWidth: 0,
    });
    expect(flattenStyle(styles.settingValue)).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
    });
  });

  it('keeps GTD segmented controls in a single connected row', () => {
    expect(flattenStyle(styles.gtdSegmentedControl)).toMatchObject({
      flexDirection: 'row',
    });
    expect(flattenStyle(styles.gtdSegmentedOption)).toMatchObject({
      flexBasis: 0,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
    });
    expect(flattenStyle(styles.gtdSegmentedOptionText)).toMatchObject({
      flexShrink: 1,
      lineHeight: 18,
      minWidth: 0,
      textAlign: 'center',
    });
  });

  it('lets picker and calendar action buttons use a full wrapped row', () => {
    expect(flattenStyle(styles.backendOption)).toMatchObject({
      maxWidth: '100%',
      flexShrink: 1,
    });
    expect(flattenStyle(styles.backendOptionText)).toMatchObject({
      flexShrink: 1,
      lineHeight: 17,
      minWidth: 0,
      textAlign: 'center',
    });
    expect(flattenStyle(styles.pickerOptionText)).toMatchObject({
      flex: 1,
      minWidth: 0,
    });
  });

  it('lets compact suggestion and setting descriptions wrap at larger text sizes', () => {
    expect(flattenStyle(styles.settingDescription)).toMatchObject({
      flexShrink: 1,
      lineHeight: 18,
      minWidth: 0,
    });
    expect(flattenStyle(styles.modelSuggestButton)).toMatchObject({
      flexShrink: 1,
    });
    expect(flattenStyle(styles.modelSuggestButtonText)).toMatchObject({
      flexShrink: 1,
      lineHeight: 16,
      minWidth: 0,
      textAlign: 'center',
    });
  });
});
