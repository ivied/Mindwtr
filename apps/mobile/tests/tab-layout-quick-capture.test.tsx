import React from 'react';
import { TouchableOpacity } from 'react-native';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TabLayout from '../app/(drawer)/(tabs)/_layout';

const mockRouterPush = vi.hoisted(() => vi.fn());
const mockTaskSettings = vi.hoisted(() => ({
  appearance: {} as Record<string, unknown>,
  gtd: {
    defaultCaptureMethod: 'text',
  },
  savedSearches: [],
}));

vi.mock('expo-router', () => {
  function LinkMock({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
  }
  function TabsScreenMock() {
    return null;
  }
  const Tabs = ({ children, tabBar }: any) => React.createElement(
    'Tabs',
    null,
    tabBar({
      state: {
        index: 0,
        key: 'tabs',
        routes: [
          { key: 'inbox-key', name: 'inbox' },
          { key: 'focus-key', name: 'focus' },
          { key: 'capture-key', name: 'capture' },
          { key: 'projects-key', name: 'projects' },
          { key: 'calendar-key', name: 'calendar-tab' },
          { key: 'contexts-key', name: 'contexts-tab' },
          { key: 'review-key', name: 'review-tab' },
          { key: 'menu-key', name: 'menu' },
        ],
      },
      descriptors: {
        'inbox-key': { options: { title: 'Inbox' } },
        'focus-key': { options: { title: 'Next' } },
        'capture-key': { options: { title: 'Add task' } },
        'projects-key': { options: { title: 'Projects' } },
        'calendar-key': { options: { title: 'Calendar' } },
        'contexts-key': { options: { title: 'Contexts' } },
        'review-key': { options: { title: 'Review' } },
        'menu-key': { options: { title: 'Menu', tabBarAccessibilityLabel: 'Menu' } },
      },
      navigation: {
        emit: vi.fn(() => ({ defaultPrevented: false })),
        dispatch: vi.fn(),
      },
    }),
    children,
  );
  Tabs.Screen = TabsScreenMock;
  return {
    Link: LinkMock,
    Tabs,
    useRouter: () => ({ push: mockRouterPush }),
  };
});

vi.mock('@react-navigation/native', () => ({
  CommonActions: {
    navigate: vi.fn((route) => ({ type: 'NAVIGATE', payload: route })),
  },
}));

vi.mock('@mindwtr/core', () => ({
  tFallback: (t: (key: string) => string, key: string, fallback: string) => {
    const translated = t(key);
    return translated && translated !== key ? translated : fallback;
  },
  useTaskStore: () => ({ settings: mockTaskSettings }),
}));

vi.mock('@/components/haptic-tab', () => ({
  HapticTab: (props: any) => React.createElement('HapticTab', props, props.children),
}));

vi.mock('@/components/ui/icon-symbol', () => ({
  IconSymbol: (props: any) => React.createElement('IconSymbol', props, props.children),
}));

vi.mock('@/components/mobile-area-switcher', () => ({
  MobileAreaSwitcher: () => React.createElement('MobileAreaSwitcher'),
}));

vi.mock('@/components/mobile-header-sync-bar', () => ({
  MobileHeaderSyncBar: () => React.createElement('MobileHeaderSyncBar'),
}));

vi.mock('@/components/quick-capture-sheet', () => ({
  QuickCaptureSheet: (props: any) => React.createElement('QuickCaptureSheet', props),
}));

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => ({ selectedAreaIdForNewTasks: null }),
}));

vi.mock('@/hooks/use-mobile-sync-badge', () => ({
  useMobileSyncBadge: () => ({ syncBadgeAccessibilityLabel: '', syncBadgeColor: '' }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a',
    border: '#334155',
    cardBg: '#111827',
    filterBg: '#1f2937',
    onTint: '#ffffff',
    secondaryText: '#94a3b8',
    tabIconDefault: '#94a3b8',
    tabIconSelected: '#f8fafc',
    text: '#f8fafc',
    tint: '#3b82f6',
  }),
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) => ({
      'nav.addTask': 'Add task',
      'nav.archived': 'Archived',
      'nav.board': 'Board View',
      'nav.calendar': 'Calendar',
      'nav.contexts': 'Contexts',
      'nav.done': 'Done',
      'nav.projects': 'Projects',
      'nav.reference': 'Reference',
      'nav.review': 'Review',
      'nav.settings': 'Settings',
      'nav.someday': 'Someday',
      'nav.trash': 'Trash',
      'nav.waiting': 'Waiting For',
      'quickAdd.audioCaptureLabel': 'Audio capture',
      'search.title': 'Search',
      'search.savedSearches': 'Saved searches',
      'tab.inbox': 'Inbox',
      'tab.menu': 'Menu',
      'tab.next': 'Next',
      'tab.review': 'Review',
      'common.close': 'Close',
    }[key] ?? key),
  }),
}));

vi.mock('../contexts/quick-capture-context', () => ({
  QuickCaptureProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const getAddTaskButton = (tree: ReturnType<typeof create>) => {
  const button = tree.root.findAllByType(TouchableOpacity).find(
    (node) => node.props.accessibilityLabel === 'Add task'
  );
  if (!button) throw new Error('Add task button not found');
  return button;
};

const getMenuButton = (tree: ReturnType<typeof create>) => {
  const button = tree.root.findAllByType(TouchableOpacity).find(
    (node) => node.props.accessibilityLabel === 'Menu'
  );
  if (!button) throw new Error('Menu button not found');
  return button;
};

const getTabButton = (tree: ReturnType<typeof create>, label: string) => {
  const button = tree.root.findAllByType(TouchableOpacity).find(
    (node) => node.props.accessibilityLabel === label
  );
  if (!button) throw new Error(`${label} tab button not found`);
  return button;
};

const getQuickCaptureSheets = (tree: ReturnType<typeof create>) => (
  tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheet')
);

const getMoreSheetButtons = (tree: ReturnType<typeof create>, label: string) => (
  tree.root.findAll((node) => (
    String(node.type) === 'Pressable'
    && node.props.accessibilityLabel === label
    && node.props.accessibilityRole === 'button'
    && typeof node.props.onPress === 'function'
  ))
);

const getMoreSheetButtonIconName = (tree: ReturnType<typeof create>, label: string) => {
  const button = getMoreSheetButtons(tree, label)[0];
  if (!button) throw new Error(`${label} button not found`);
  const icon = button.findAll((node) => String(node.type) === 'IconSymbol')[0];
  if (!icon) throw new Error(`${label} icon not found`);
  return icon.props.name;
};

const moreDestinationLabels = [
  'Trash',
  'Archived',
  'Done',
  'Reference',
  'Settings',
  'Waiting For',
  'Board View',
  'Projects',
  'Someday',
  'Contexts',
  'Calendar',
];
const moreSheetDestinationLabels = [...moreDestinationLabels, 'Review'];

const hasHiddenAccessibilityAncestor = (node: any) => {
  let parent = node.parent;
  while (parent) {
    if (
      parent.props?.accessibilityElementsHidden
      || parent.props?.importantForAccessibility === 'no-hide-descendants'
    ) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
};

const getVisibleMoreDestinationLabels = (tree: ReturnType<typeof create>) => (
  tree.root
    .findAll((node) => (
      String(node.type) === 'Pressable'
      && node.props.accessibilityRole === 'button'
      && typeof node.props.onPress === 'function'
      && moreSheetDestinationLabels.includes(node.props.accessibilityLabel)
      && !hasHiddenAccessibilityAncestor(node)
    ))
    .map((node) => node.props.accessibilityLabel)
);

const getMoreSheetMenu = (tree: ReturnType<typeof create>) => {
  const menu = tree.root.findAll((node) => (
    String(node.type) === 'Animated.View'
    && node.props.accessibilityRole === 'menu'
  ))[0];
  if (!menu) throw new Error('More sheet menu not found');
  return menu;
};

describe('mobile tab quick capture', () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
    mockTaskSettings.appearance = {};
    mockTaskSettings.gtd.defaultCaptureMethod = 'text';
    mockTaskSettings.savedSearches = [];
  });

  it('unmounts the quick capture sheet after close so the next plus tap gets a fresh modal', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    expect(getQuickCaptureSheets(tree)).toHaveLength(0);

    act(() => {
      getAddTaskButton(tree).props.onPress();
    });

    let sheets = getQuickCaptureSheets(tree);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.props.visible).toBe(true);

    act(() => {
      sheets[0]?.props.onClose();
    });

    expect(getQuickCaptureSheets(tree)).toHaveLength(0);

    act(() => {
      getAddTaskButton(tree).props.onPress();
    });

    sheets = getQuickCaptureSheets(tree);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.props.visible).toBe(true);
  });

  it('increments the open request id without key-remounting the sheet', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    act(() => {
      getAddTaskButton(tree).props.onPress();
    });

    let sheets = getQuickCaptureSheets(tree);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.props.openRequestId).toBe(1);

    act(() => {
      getAddTaskButton(tree).props.onPress();
    });

    sheets = getQuickCaptureSheets(tree);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.props.openRequestId).toBe(2);
  });

  it('opens the More sheet from the menu tab and navigates from its original calendar icon', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    expect(getMoreSheetButtons(tree, 'Calendar')).toHaveLength(0);

    act(() => {
      getMenuButton(tree).props.onPress();
    });

    expect(getVisibleMoreDestinationLabels(tree)).toEqual(moreDestinationLabels);
    expect(getMoreSheetButtonIconName(tree, 'Board View')).toBe('square.grid.2x2.fill');
    expect(getMoreSheetButtonIconName(tree, 'Someday')).toBe('arrow.up.circle.fill');

    const calendarButtons = getMoreSheetButtons(tree, 'Calendar');
    expect(calendarButtons.length).toBeGreaterThan(0);

    act(() => {
      calendarButtons[0]?.props.onPress();
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/calendar');
    expect(getMoreSheetButtons(tree, 'Calendar')).toHaveLength(0);
  });

  it('swaps a selected quick access view with Review in the More sheet', () => {
    mockTaskSettings.appearance = { mobileQuickAccessView: 'projects' };
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    expect(getTabButton(tree, 'Projects')).toBeTruthy();

    act(() => {
      getMenuButton(tree).props.onPress();
    });

    expect(getVisibleMoreDestinationLabels(tree)).toEqual([
      'Trash',
      'Archived',
      'Done',
      'Reference',
      'Settings',
      'Waiting For',
      'Board View',
      'Review',
      'Someday',
      'Contexts',
      'Calendar',
    ]);
    expect(getMoreSheetButtons(tree, 'Projects')).toHaveLength(0);

    const reviewButtons = getMoreSheetButtons(tree, 'Review');
    expect(reviewButtons.length).toBeGreaterThan(0);

    act(() => {
      reviewButtons[0]?.props.onPress();
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/review');
  });

  it('closes the More sheet from the menu tab toggle and a downward swipe', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    act(() => {
      getMenuButton(tree).props.onPress();
    });
    expect(getVisibleMoreDestinationLabels(tree)).toEqual(moreDestinationLabels);

    act(() => {
      getMenuButton(tree).props.onPress();
    });
    expect(getVisibleMoreDestinationLabels(tree)).toHaveLength(0);

    act(() => {
      getMenuButton(tree).props.onPress();
    });
    const menu = getMoreSheetMenu(tree);
    expect(menu.props.onMoveShouldSetResponder?.({}, { dx: 2, dy: 12 })).toBe(true);

    act(() => {
      menu.props.onResponderRelease?.({}, { dx: 4, dy: 24, vy: 0.2 });
    });
    expect(getVisibleMoreDestinationLabels(tree)).toHaveLength(0);
  });

  it('dismisses the full More sheet on a long downward swipe', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    act(() => {
      getMenuButton(tree).props.onPress();
    });
    expect(getVisibleMoreDestinationLabels(tree)).toEqual(moreDestinationLabels);

    act(() => {
      getMoreSheetMenu(tree).props.onResponderRelease?.({}, { dx: 4, dy: 240, vy: 0.2 });
    });
    expect(getVisibleMoreDestinationLabels(tree)).toHaveLength(0);
  });
});
