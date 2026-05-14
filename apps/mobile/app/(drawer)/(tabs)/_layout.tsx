import { Link, Tabs, useRouter } from 'expo-router';
import { CommonActions } from '@react-navigation/native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Search, Inbox, ArrowRightCircle, Calendar, Circle, ClipboardCheck, Folder, Menu, Mic, Plus } from 'lucide-react-native';
import { Animated, Dimensions, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { MobileAreaSwitcher } from '@/components/mobile-area-switcher';
import { MobileHeaderSyncBar } from '@/components/mobile-header-sync-bar';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useMobileSyncBadge } from '@/hooks/use-mobile-sync-badge';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '../../../contexts/language-context';
import { QuickCaptureSheet } from '@/components/quick-capture-sheet';
import { QuickCaptureProvider } from '../../../contexts/quick-capture-context';
import { useTaskStore, type MobileQuickAccessView, type SavedSearch, type Task } from '@mindwtr/core';
import {
  coerceMobileQuickAccessView,
  MOBILE_QUICK_ACCESS_STACK_ROUTE,
  MOBILE_QUICK_ACCESS_TAB_ROUTE,
} from '@/lib/mobile-quick-access-view';

type IconSymbolName = Parameters<typeof IconSymbol>[0]['name'];
type Translate = (key: string) => string;

type MoreDestination = {
  id: string;
  label: string;
  displayLabel?: string;
  icon: IconSymbolName;
  iconColor: string;
  route?: string;
  onPress?: () => void;
};

function compactSlashLabel(label: string) {
  return label.split('/')[0]?.trim() || label;
}

function MoreSheetTile({
  item,
  onNavigate,
  tc,
}: {
  item: MoreDestination;
  onNavigate: (route: string) => void;
  tc: ReturnType<typeof useThemeColors>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.label}
      onPress={() => {
        if (item.route) {
          onNavigate(item.route);
          return;
        }
        item.onPress?.();
      }}
      style={({ pressed }) => [
        styles.moreTile,
        {
          backgroundColor: pressed ? tc.filterBg : tc.cardBg,
          borderColor: tc.border,
        },
      ]}
    >
      <View style={[styles.moreTileIcon, { backgroundColor: tc.filterBg }]}>
        <IconSymbol name={item.icon} size={24} color={item.iconColor} />
      </View>
      <Text style={[styles.moreTileLabel, { color: tc.text }]} numberOfLines={1}>
        {item.displayLabel ?? item.label}
      </Text>
    </Pressable>
  );
}

function MoreSheetCompactItem({
  itemStyle,
  item,
  onNavigate,
  tc,
}: {
  itemStyle?: ViewStyle;
  item: MoreDestination;
  onNavigate: (route: string) => void;
  tc: ReturnType<typeof useThemeColors>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.label}
      onPress={() => {
        if (item.route) {
          onNavigate(item.route);
          return;
        }
        item.onPress?.();
      }}
      style={({ pressed }) => [
        styles.moreCompactItem,
        itemStyle,
        { backgroundColor: pressed ? tc.filterBg : 'transparent' },
      ]}
    >
      <View style={styles.moreCompactIcon}>
        <IconSymbol name={item.icon} size={18} color={item.iconColor} />
      </View>
      <Text style={[styles.moreCompactLabel, { color: tc.secondaryText }]} numberOfLines={1}>
        {item.displayLabel ?? item.label}
      </Text>
    </Pressable>
  );
}

function MoreNavigationSheet({
  closeRequestId,
  onClose,
  onNavigate,
  savedSearches,
  t,
  tabBarHeight,
  tc,
  visible,
  quickAccessView,
}: {
  closeRequestId: number;
  onClose: () => void;
  onNavigate: (route: string) => void;
  savedSearches: SavedSearch[];
  t: Translate;
  tabBarHeight: number;
  tc: ReturnType<typeof useThemeColors>;
  visible: boolean;
  quickAccessView: MobileQuickAccessView;
}) {
  const sheetTranslateY = useRef(new Animated.Value(Dimensions.get('window').height)).current;
  const lastCloseRequestIdRef = useRef(closeRequestId);
  const hiddenTranslateY = Dimensions.get('window').height;
  const iconColors = {
    board: '#4F8CF7',
    review: '#22C55E',
    calendar: '#35B8B1',
    projects: '#10B981',
    contexts: '#8B5CF6',
    waiting: '#F2B705',
    someday: '#6366F1',
    reference: '#0EA5E9',
    done: '#22C55E',
    archived: '#64748B',
    trash: '#EF4444',
    settings: '#64748B',
    saved: '#4F8CF7',
  };

  const animateClosed = useCallback(() => {
    Animated.timing(sheetTranslateY, {
      toValue: hiddenTranslateY,
      duration: 180,
      useNativeDriver: true,
    }).start(() => {
      onClose();
    });
  }, [hiddenTranslateY, onClose, sheetTranslateY]);
  const animateOpen = useCallback(() => {
    sheetTranslateY.setValue(hiddenTranslateY);
    Animated.timing(sheetTranslateY, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [hiddenTranslateY, sheetTranslateY]);
  const restoreOpenPosition = useCallback(() => {
    Animated.timing(sheetTranslateY, {
      toValue: 0,
      duration: 140,
      useNativeDriver: true,
    }).start();
  }, [sheetTranslateY]);
  const closeSheet = useCallback(() => {
    animateClosed();
  }, [animateClosed]);
  const sheetPanResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gestureState) => (
      gestureState.dy > 8
      && gestureState.dy > Math.abs(gestureState.dx)
    ),
    onPanResponderMove: (_event, gestureState) => {
      sheetTranslateY.setValue(Math.max(0, gestureState.dy));
    },
    onPanResponderRelease: (_event, gestureState) => {
      if (gestureState.dy > 8 || gestureState.vy > 0.25) {
        closeSheet();
        return;
      }
      restoreOpenPosition();
    },
    onPanResponderTerminate: (_event, gestureState) => {
      if (gestureState.dy > 8 || gestureState.vy > 0.25) {
        closeSheet();
        return;
      }
      restoreOpenPosition();
    },
  }), [closeSheet, restoreOpenPosition, sheetTranslateY]);

  useEffect(() => {
    if (visible) animateOpen();
  }, [animateOpen, visible]);

  useEffect(() => {
    if (lastCloseRequestIdRef.current === closeRequestId) return;
    lastCloseRequestIdRef.current = closeRequestId;
    if (visible) animateClosed();
  }, [animateClosed, closeRequestId, visible]);

  if (!visible) return null;

  const quickAccessItems: Record<MobileQuickAccessView, MoreDestination> = {
    review: { id: 'review', label: t('nav.review'), icon: 'clipboard.fill', iconColor: iconColors.review, route: MOBILE_QUICK_ACCESS_STACK_ROUTE.review },
    projects: { id: 'projects', label: t('nav.projects'), icon: 'folder.fill', iconColor: iconColors.projects, route: MOBILE_QUICK_ACCESS_STACK_ROUTE.projects },
    calendar: { id: 'calendar', label: t('nav.calendar'), icon: 'calendar', iconColor: iconColors.calendar, route: MOBILE_QUICK_ACCESS_STACK_ROUTE.calendar },
    contexts: { id: 'contexts', label: t('nav.contexts'), icon: 'circle', iconColor: iconColors.contexts, route: MOBILE_QUICK_ACCESS_STACK_ROUTE.contexts },
  };
  const moreQuickAccessItem = (view: Exclude<MobileQuickAccessView, 'review'>) => (
    quickAccessView === view ? quickAccessItems.review : quickAccessItems[view]
  );
  const primaryItems: MoreDestination[] = [
    { id: 'waiting', label: t('nav.waiting'), icon: 'pause.circle.fill', iconColor: iconColors.waiting, route: '/waiting' },
    { id: 'board', label: t('nav.board'), icon: 'square.grid.2x2.fill', iconColor: iconColors.board, route: '/board' },
    moreQuickAccessItem('projects'),
    {
      id: 'someday',
      label: t('nav.someday'),
      displayLabel: compactSlashLabel(t('nav.someday')),
      icon: 'arrow.up.circle.fill',
      iconColor: iconColors.someday,
      route: '/someday',
    },
    moreQuickAccessItem('contexts'),
    moreQuickAccessItem('calendar'),
  ];
  const secondaryItems: MoreDestination[] = [
    { id: 'trash', label: t('nav.trash'), icon: 'trash.fill', iconColor: iconColors.trash, route: '/trash' },
    { id: 'archived', label: t('nav.archived'), icon: 'archivebox.fill', iconColor: iconColors.archived, route: '/archived' },
    { id: 'done', label: t('nav.done'), icon: 'checkmark.circle.fill', iconColor: iconColors.done, route: '/done' },
    { id: 'reference', label: t('nav.reference'), displayLabel: 'Refer', icon: 'book.closed.fill', iconColor: iconColors.reference, route: '/reference' },
    { id: 'settings', label: t('nav.settings'), icon: 'gearshape.fill', iconColor: iconColors.settings, route: '/settings' },
  ];

  return (
    <>
      <View pointerEvents="box-none" style={[styles.moreOverlayContainer, { bottom: tabBarHeight }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
          style={styles.moreBackdrop}
          onPress={closeSheet}
        />
        <Animated.View
          accessibilityRole="menu"
          style={[
            styles.moreSheet,
            {
              backgroundColor: tc.cardBg,
              borderColor: tc.border,
              bottom: 0,
              transform: [{ translateY: sheetTranslateY }],
            },
          ]}
          {...sheetPanResponder.panHandlers}
        >
          <View style={[styles.moreSheetHandle, { backgroundColor: tc.border }]} />
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.moreSheetContent}
          >
            <View style={styles.moreUtilityRow}>
              {secondaryItems.map((item) => (
                <MoreSheetCompactItem
                  key={item.id}
                  item={item}
                  itemStyle={styles.moreUtilityRowItem}
                  onNavigate={onNavigate}
                  tc={tc}
                />
              ))}
            </View>

            {savedSearches.length > 0 ? (
              <View style={styles.moreSavedSection}>
                <Text style={[styles.moreSectionTitle, { color: tc.secondaryText }]}>
                  {t('search.savedSearches')}
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.moreUtilityStripContent}
                >
                  {savedSearches.map((search) => (
                    <MoreSheetCompactItem
                      key={search.id}
                      item={{
                        id: search.id,
                        label: search.name,
                        icon: 'tray.fill',
                        iconColor: iconColors.saved,
                        route: `/saved-search/${search.id}`,
                      }}
                      itemStyle={styles.moreUtilityScrollItem}
                      onNavigate={onNavigate}
                      tc={tc}
                    />
                  ))}
                </ScrollView>
              </View>
            ) : null}

            <View style={[styles.moreDivider, { backgroundColor: tc.border }]} />

            <View style={styles.morePrimaryGrid}>
              {primaryItems.map((item) => (
                <MoreSheetTile key={item.id} item={item} onNavigate={onNavigate} tc={tc} />
              ))}
            </View>
          </ScrollView>
        </Animated.View>
      </View>

    </>
  );
}

function NativeTabBar({
  state,
  descriptors,
  navigation,
  iconTint,
  inactiveTint,
  tc,
  tabBarHeight,
  tabBarBottomInset,
  tabBarBottomOffset,
  tabItemTopOffset,
  iconLift,
  openQuickCapture,
  closeMoreSheet,
  toggleMoreSheet,
  defaultAutoRecord,
  addTaskAccessibilityLabel,
  audioCaptureAccessibilityLabel,
  menuSyncIndicatorColor,
  moreSheetVisible,
  quickAccessTabRoute,
}: BottomTabBarProps & {
  iconTint: string;
  inactiveTint: string;
  tc: { cardBg: string; border: string; onTint: string; tint: string };
  tabBarHeight: number;
  tabBarBottomInset: number;
  tabBarBottomOffset: number;
  tabItemTopOffset: number;
  iconLift: number;
  openQuickCapture: (options?: { initialValue?: string; initialProps?: Partial<Task>; autoRecord?: boolean }) => void;
  closeMoreSheet: () => void;
  toggleMoreSheet: () => void;
  defaultAutoRecord: boolean;
  addTaskAccessibilityLabel: string;
  audioCaptureAccessibilityLabel: string;
  menuSyncIndicatorColor?: string;
  moreSheetVisible: boolean;
  quickAccessTabRoute: string;
}) {
  const longPressRef = useRef(false);
  const visibleTabNames = new Set(['inbox', 'focus', 'capture', quickAccessTabRoute, 'menu']);
  const visibleRoutes = state.routes.filter((route) => visibleTabNames.has(route.name));

  return (
    <View
      style={[
        styles.nativeTabBar,
        {
          backgroundColor: tc.cardBg,
          borderTopColor: tc.border,
          height: tabBarHeight,
          paddingBottom: tabBarBottomInset,
          marginBottom: tabBarBottomOffset,
        },
      ]}
    >
      {visibleRoutes.map((route) => {
        const focused = state.routes[state.index]?.key === route.key;
        const descriptor = descriptors[route.key];
        const options = descriptor.options;

        if (route.name === 'capture') {
          return (
            <TouchableOpacity
              key={route.key}
              onPress={() => {
                if (longPressRef.current) {
                  longPressRef.current = false;
                  return;
                }
                if (moreSheetVisible) closeMoreSheet();
                openQuickCapture({ autoRecord: defaultAutoRecord });
              }}
              onLongPress={() => {
                longPressRef.current = true;
                if (moreSheetVisible) closeMoreSheet();
                openQuickCapture({ autoRecord: !defaultAutoRecord });
                setTimeout(() => {
                  longPressRef.current = false;
                }, 400);
              }}
              accessibilityRole="button"
              accessibilityLabel={defaultAutoRecord ? audioCaptureAccessibilityLabel : addTaskAccessibilityLabel}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={[
                styles.nativeTabItem,
                { paddingTop: iconLift, transform: [{ translateY: tabItemTopOffset }] },
              ]}
            >
              <View style={[styles.captureButtonInner, { backgroundColor: tc.tint }]}>
                {defaultAutoRecord ? (
                  <Mic size={24} color={tc.onTint} strokeWidth={2.5} />
                ) : (
                  <Plus size={24} color={tc.onTint} strokeWidth={3} />
                )}
              </View>
            </TouchableOpacity>
          );
        }

        const active = route.name === 'menu' ? moreSheetVisible : focused;

        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (event.defaultPrevented) return;
          if (route.name === 'menu') {
            toggleMoreSheet();
            return;
          }
          if (moreSheetVisible) closeMoreSheet();
          if (focused) return;
          navigation.dispatch({
            ...CommonActions.navigate(route),
            target: state.key,
          });
        };

        const onLongPress = () => {
          navigation.emit({ type: 'tabLongPress', target: route.key });
        };

        const tabIcon = options.tabBarIcon?.({
          focused: active,
          color: active ? iconTint : inactiveTint,
          size: active ? 26 : 24,
        });

        return (
          <TouchableOpacity
            key={route.key}
            accessibilityRole="button"
            accessibilityState={route.name === 'menu' ? { expanded: moreSheetVisible } : focused ? { selected: true } : {}}
            accessibilityLabel={options.tabBarAccessibilityLabel ?? options.title}
            testID={options.tabBarButtonTestID}
            onPress={onPress}
            onLongPress={onLongPress}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={[
              styles.nativeTabItem,
              { paddingTop: iconLift, transform: [{ translateY: tabItemTopOffset }] },
            ]}
          >
            <View style={styles.nativeTabIconWrap}>
              {tabIcon}
              {route.name === 'menu' && menuSyncIndicatorColor ? (
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                  style={[
                    styles.menuSyncDot,
                    {
                      backgroundColor: menuSyncIndicatorColor,
                      borderColor: tc.cardBg,
                    },
                  ]}
                />
              ) : null}
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function TabLayout() {
  const tc = useThemeColors();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { settings } = useTaskStore();
  const androidNavInset = Platform.OS === 'android' && insets.bottom >= 20
    ? Math.max(0, insets.bottom - 12)
    : 0;
  const iosBottomInset = Platform.OS === 'ios'
    ? Math.max(0, insets.bottom - 12)
    : 0;
  const tabBarBottomInset = Platform.OS === 'ios' ? iosBottomInset : androidNavInset;
  const tabBarBottomOffset = 0;
  const tabItemTopOffset = Platform.OS === 'ios' ? 0 : -6;
  const tabBarHeight = 58 + tabBarBottomInset;
  const iconLift = Platform.OS === 'android' ? 4 : 0;
  const [captureState, setCaptureState] = useState<{
    visible: boolean;
    openRequestId: number;
    initialValue?: string;
    initialProps?: Partial<Task> | null;
    autoRecord?: boolean;
  }>({
    visible: false,
    openRequestId: 0,
    initialValue: '',
    initialProps: null,
    autoRecord: false,
  });
  const [moreSheetVisible, setMoreSheetVisible] = useState(false);
  const [moreSheetCloseRequestId, setMoreSheetCloseRequestId] = useState(0);
  const longPressRef = useRef(false);
  const { selectedAreaIdForNewTasks } = useMobileAreaFilter();

  const withSelectedArea = useCallback((initialProps?: Partial<Task> | null): Partial<Task> | undefined => {
    const nextInitialProps = initialProps ? { ...initialProps } : {};
    if (!nextInitialProps.projectId && !nextInitialProps.areaId && selectedAreaIdForNewTasks) {
      nextInitialProps.areaId = selectedAreaIdForNewTasks;
    }
    return Object.keys(nextInitialProps).length > 0 ? nextInitialProps : undefined;
  }, [selectedAreaIdForNewTasks]);

  const openQuickCapture = useCallback((options?: { initialValue?: string; initialProps?: Partial<Task>; autoRecord?: boolean }) => {
    setCaptureState((prev) => ({
      visible: true,
      openRequestId: prev.openRequestId + 1,
      initialValue: options?.initialValue ?? '',
      initialProps: withSelectedArea(options?.initialProps) ?? null,
      autoRecord: options?.autoRecord ?? false,
    }));
  }, [withSelectedArea]);

  const closeQuickCapture = useCallback(() => {
    setCaptureState((prev) => ({
      visible: false,
      openRequestId: prev.openRequestId,
      initialValue: '',
      initialProps: null,
      autoRecord: false,
    }));
  }, []);
  const closeMoreSheet = useCallback(() => setMoreSheetVisible(false), []);
  const toggleMoreSheet = useCallback(() => {
    if (moreSheetVisible) {
      setMoreSheetCloseRequestId((prev) => prev + 1);
      return;
    }
    setMoreSheetVisible(true);
  }, [moreSheetVisible]);
  const navigateFromMoreSheet = useCallback((route: string) => {
    setMoreSheetVisible(false);
    router.push(route as never);
  }, [router]);

  const iconTint = tc.tabIconSelected;
  const inactiveTint = tc.tabIconDefault;
  const captureColor = tc.tint;
  const defaultCapture = settings.gtd?.defaultCaptureMethod ?? 'text';
  const defaultAutoRecord = defaultCapture === 'audio';
  const quickAccessView = coerceMobileQuickAccessView(settings.appearance?.mobileQuickAccessView);
  const quickAccessTabRoute = MOBILE_QUICK_ACCESS_TAB_ROUTE[quickAccessView];
  const { syncBadgeAccessibilityLabel, syncBadgeColor } = useMobileSyncBadge();

  return (
    <QuickCaptureProvider value={{ openQuickCapture }}>
      <Tabs
        initialRouteName="inbox"
        tabBar={(props) => (
          <NativeTabBar
            {...props}
            iconTint={iconTint}
            inactiveTint={inactiveTint}
            tc={{ cardBg: tc.cardBg, border: tc.border, onTint: tc.onTint, tint: tc.tint }}
            tabBarHeight={tabBarHeight}
            tabBarBottomInset={tabBarBottomInset}
            tabBarBottomOffset={tabBarBottomOffset}
            tabItemTopOffset={tabItemTopOffset}
            iconLift={iconLift}
            openQuickCapture={openQuickCapture}
            closeMoreSheet={closeMoreSheet}
            toggleMoreSheet={toggleMoreSheet}
            defaultAutoRecord={defaultAutoRecord}
            addTaskAccessibilityLabel={t('nav.addTask')}
            audioCaptureAccessibilityLabel={t('quickAdd.audioCaptureLabel')}
            menuSyncIndicatorColor={syncBadgeColor}
            moreSheetVisible={moreSheetVisible}
            quickAccessTabRoute={quickAccessTabRoute}
          />
        )}
        screenOptions={({ route }) => ({
        tabBarActiveTintColor: iconTint,
        tabBarInactiveTintColor: inactiveTint,
        tabBarShowLabel: false,
        headerShown: true,
        headerTitleAlign: 'center',
        headerShadowVisible: false,
        headerStyle: {
          backgroundColor: tc.cardBg,
          borderBottomWidth: 0,
        },
        headerBackground: () => (
          <View
            style={[
              StyleSheet.absoluteFillObject,
              {
                backgroundColor: tc.cardBg,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: tc.border,
              },
            ]}
          >
            <MobileHeaderSyncBar />
          </View>
        ),
        headerLeft: () => <MobileAreaSwitcher />,
        headerLeftContainerStyle: {
          paddingLeft: 16,
        },
        headerTintColor: tc.text,
        headerTitleStyle: {
          fontSize: 17,
          fontWeight: '700',
        },
        headerRight: route.name === 'menu'
          ? undefined
          : () => (
            <Link href="/global-search" asChild>
              <TouchableOpacity style={styles.headerIconButton} accessibilityLabel={t('search.title')}>
                <Search size={22} color={tc.text} />
              </TouchableOpacity>
            </Link>
          ),
        headerRightContainerStyle: {
          paddingRight: 16,
        },
        tabBarButton: (props) => (
          <HapticTab
            {...props}
            activeBackgroundColor="transparent"
            inactiveBackgroundColor="transparent"
            activeIndicatorColor="transparent"
            indicatorHeight={0}
          />
        ),
      })}
      >
        <Tabs.Screen
        name="inbox"
        options={{
          title: t('tab.inbox'),
          tabBarIcon: ({ color, focused }) => (
            <Inbox size={focused ? 26 : 24} color={color} strokeWidth={2} opacity={focused ? 1 : 0.8} />
          ),
        }}
      />
      <Tabs.Screen
        name="focus"
        options={{
          title: t('tab.next'),
          tabBarIcon: ({ color, focused }) => (
            <ArrowRightCircle size={focused ? 26 : 24} color={color} strokeWidth={2} opacity={focused ? 1 : 0.8} />
          ),
        }}
      />
      <Tabs.Screen
        name="capture"
        options={{
          title: t('nav.addTask'),
          tabBarButton: () => (
            <TouchableOpacity
              onPress={() => {
                if (longPressRef.current) {
                  longPressRef.current = false;
                  return;
                }
                openQuickCapture({ autoRecord: defaultAutoRecord });
              }}
              onLongPress={() => {
                longPressRef.current = true;
                openQuickCapture({ autoRecord: !defaultAutoRecord });
                setTimeout(() => {
                  longPressRef.current = false;
                }, 400);
              }}
              accessibilityRole="button"
              accessibilityLabel={defaultAutoRecord ? t('quickAdd.audioCaptureLabel') : t('nav.addTask')}
              style={styles.captureButton}
            >
              <View style={[styles.captureButtonInner, { backgroundColor: captureColor }]}>
                {defaultAutoRecord ? (
                  <Mic size={24} color={tc.onTint} strokeWidth={2.5} />
                ) : (
                  <Plus size={24} color={tc.onTint} strokeWidth={3} />
                )}
              </View>
            </TouchableOpacity>
          ),
        }}
      />
      <Tabs.Screen
        name="capture-quick"
        options={{
          href: null,
        }}
      />
      <Tabs.Screen
        name="projects"
        options={{
          title: t('projects.title'),
          href: quickAccessView === 'projects' ? undefined : null,
          tabBarIcon: ({ color, focused }) => (
            <Folder size={focused ? 26 : 24} color={color} strokeWidth={2} opacity={focused ? 1 : 0.8} />
          ),
        }}
      />
      <Tabs.Screen
        name="calendar-tab"
        options={{
          title: t('nav.calendar'),
          href: quickAccessView === 'calendar' ? undefined : null,
          tabBarIcon: ({ color, focused }) => (
            <Calendar size={focused ? 26 : 24} color={color} strokeWidth={2} opacity={focused ? 1 : 0.8} />
          ),
        }}
      />
      <Tabs.Screen
        name="contexts-tab"
        options={{
          title: t('nav.contexts'),
          href: quickAccessView === 'contexts' ? undefined : null,
          tabBarIcon: ({ color, focused }) => (
            <Circle size={focused ? 26 : 24} color={color} strokeWidth={2} opacity={focused ? 1 : 0.8} />
          ),
        }}
      />
      <Tabs.Screen
        name="review-tab"
        options={{
          title: t('tab.review'),
          href: quickAccessView === 'review' ? undefined : null,
          tabBarIcon: ({ color, focused }) => (
            <ClipboardCheck size={focused ? 26 : 24} color={color} strokeWidth={2} opacity={focused ? 1 : 0.8} />
          ),
        }}
      />
      <Tabs.Screen
        name="menu"
        options={{
          title: t('tab.menu'),
          tabBarAccessibilityLabel: syncBadgeAccessibilityLabel
            ? `${t('tab.menu')}, ${syncBadgeAccessibilityLabel}`
            : t('tab.menu'),
          tabBarIcon: ({ color, focused }) => (
            <Menu size={focused ? 26 : 24} color={color} strokeWidth={2} opacity={focused ? 1 : 0.8} />
          ),
        }}
      />
    </Tabs>
    {captureState.visible && (
      <QuickCaptureSheet
        visible
        openRequestId={captureState.openRequestId}
        initialValue={captureState.initialValue}
        initialProps={captureState.initialProps ?? undefined}
        autoRecord={captureState.autoRecord}
        onClose={closeQuickCapture}
      />
    )}
    <MoreNavigationSheet
      closeRequestId={moreSheetCloseRequestId}
      onClose={closeMoreSheet}
      onNavigate={navigateFromMoreSheet}
      savedSearches={settings?.savedSearches ?? []}
      t={t}
      tabBarHeight={tabBarHeight}
      tc={tc}
      visible={moreSheetVisible}
      quickAccessView={quickAccessView}
    />
    </QuickCaptureProvider>
  );
}

const styles = StyleSheet.create({
  nativeTabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: 'stretch',
    overflow: 'visible',
  },
  nativeTabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nativeTabIconWrap: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  menuSyncDot: {
    position: 'absolute',
    top: -2,
    right: -7,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    borderWidth: 1.5,
    opacity: 0.85,
  },
  headerIconButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureButtonInner: {
    width: 52,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -4,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  moreOverlayContainer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    elevation: 20,
    overflow: 'hidden',
  },
  moreBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.36)',
  },
  moreSheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    maxHeight: '82%',
    paddingTop: 10,
    paddingHorizontal: 18,
    paddingBottom: 16,
  },
  moreSheetHandle: {
    alignSelf: 'center',
    width: 44,
    height: 5,
    borderRadius: 3,
    marginBottom: 18,
  },
  moreSheetContent: {
    paddingBottom: 8,
  },
  morePrimaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  moreTile: {
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexBasis: '31%',
    flexGrow: 1,
    minHeight: 86,
    paddingHorizontal: 8,
    paddingVertical: 12,
  },
  moreTileIcon: {
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  moreTileLabel: {
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 15,
    minHeight: 15,
    textAlign: 'center',
  },
  moreDivider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 12,
  },
  moreUtilityRow: {
    flexDirection: 'row',
    gap: 4,
  },
  moreUtilityStripContent: {
    flexDirection: 'row',
    gap: 10,
    paddingRight: 2,
  },
  moreCompactItem: {
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 2,
    paddingVertical: 4,
  },
  moreUtilityRowItem: {
    flex: 1,
    minWidth: 0,
  },
  moreUtilityScrollItem: {
    width: 76,
  },
  moreCompactIcon: {
    opacity: 0.64,
  },
  moreCompactLabel: {
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 12,
    marginTop: 4,
    minHeight: 24,
    textAlign: 'center',
  },
  moreSavedSection: {
    marginTop: 18,
  },
  moreSectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
});
