import React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Database, Download, RefreshCw, X } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';

type MobileOnboardingFlowProps = {
  busy?: boolean;
  error?: string | null;
  isOpen: boolean;
  onOpenImport: () => void;
  onOpenSync: () => void;
  onSkip: () => void;
  onStartFresh: () => void;
};

export function MobileOnboardingFlow({
  busy = false,
  error = null,
  isOpen,
  onOpenImport,
  onOpenSync,
  onSkip,
  onStartFresh,
}: MobileOnboardingFlowProps) {
  const tc = useThemeColors();
  const filledButton = useFilledButtonColors();

  return (
    <Modal animationType="fade" transparent visible={isOpen} onRequestClose={onSkip}>
      <SafeAreaView style={styles.overlay}>
        <View style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
          <View style={[styles.header, { borderBottomColor: tc.border }]}>
            <View style={styles.headerText}>
              <Text style={[styles.title, { color: tc.text }]}>Welcome to Mindwtr</Text>
              <Text style={[styles.subtitle, { color: tc.secondaryText }]}>
                Start with your existing data, or add a small Getting Started project to learn the loop.
              </Text>
            </View>
            <Pressable
              accessibilityLabel="Skip onboarding"
              accessibilityRole="button"
              disabled={busy}
              hitSlop={8}
              onPress={onSkip}
              style={({ pressed }) => [
                styles.closeButton,
                { opacity: pressed ? 0.72 : busy ? 0.45 : 1 },
              ]}
            >
              <X color={tc.secondaryText} size={22} strokeWidth={2.2} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body} bounces={false}>
            <OnboardingOption
              disabled={busy}
              description="Connect Dropbox, WebDAV, iCloud, or a local sync folder before adding starter data."
              icon={<RefreshCw color={tc.tint} size={22} strokeWidth={2.2} />}
              onPress={onOpenSync}
              title="Set up sync"
            />
            <OnboardingOption
              disabled={busy}
              description="Bring in a Todoist, OmniFocus, DGT, Apple Reminders, or Mindwtr backup file first."
              icon={<Download color={tc.tint} size={22} strokeWidth={2.2} />}
              onPress={onOpenImport}
              title="Import tasks"
            />
            <TouchableOpacity
              accessibilityRole="button"
              activeOpacity={0.82}
              disabled={busy}
              onPress={onStartFresh}
              style={[
                styles.option,
                styles.primaryOption,
                { backgroundColor: filledButton.backgroundColor, borderColor: filledButton.backgroundColor, opacity: busy ? 0.68 : 1 },
              ]}
            >
              <View style={[styles.iconSlot, styles.primaryIconSlot]}>
                {busy ? (
                  <ActivityIndicator color={filledButton.textColor ?? '#FFFFFF'} size="small" />
                ) : (
                  <Database color={filledButton.textColor ?? '#FFFFFF'} size={22} strokeWidth={2.2} />
                )}
              </View>
              <View style={styles.optionText}>
                <Text style={[styles.primaryOptionTitle, filledButton.textColor ? { color: filledButton.textColor } : null]}>{busy ? 'Starting...' : 'Start fresh'}</Text>
                <Text style={styles.primaryOptionDescription}>
                  Add a guided Getting Started project and two sample inbox items.
                </Text>
              </View>
            </TouchableOpacity>
            {error ? (
              <View style={[styles.errorBox, { borderColor: tc.danger, backgroundColor: `${tc.danger}18` }]}>
                <Text style={[styles.errorText, { color: tc.danger }]}>{error}</Text>
              </View>
            ) : null}
          </ScrollView>

          <View style={[styles.footer, { borderTopColor: tc.border }]}>
            <Text style={[styles.footerText, { color: tc.secondaryText }]}>
              You can set these up or add sample content later.
            </Text>
            <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onSkip}>
              <Text style={[styles.skipText, { color: busy ? tc.secondaryText : tc.tint }]}>Skip for now</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function OnboardingOption({
  description,
  disabled,
  icon,
  onPress,
  title,
}: {
  description: string;
  disabled?: boolean;
  icon: React.ReactNode;
  onPress: () => void;
  title: string;
}) {
  const tc = useThemeColors();

  return (
    <TouchableOpacity
      accessibilityRole="button"
      activeOpacity={0.78}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.option,
        {
          backgroundColor: tc.inputBg,
          borderColor: tc.border,
          opacity: disabled ? 0.58 : 1,
        },
      ]}
    >
      <View style={[styles.iconSlot, { backgroundColor: `${tc.tint}18` }]}>{icon}</View>
      <View style={styles.optionText}>
        <Text style={[styles.optionTitle, { color: tc.text }]}>{title}</Text>
        <Text style={[styles.optionDescription, { color: tc.secondaryText }]}>{description}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.68)',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 20,
  },
  card: {
    width: '100%',
    maxHeight: '92%',
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  header: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 18,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 21,
    marginTop: 6,
  },
  closeButton: {
    alignItems: 'center',
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  body: {
    gap: 12,
    padding: 20,
  },
  option: {
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 14,
    minHeight: 88,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  primaryOption: {
    minHeight: 92,
  },
  iconSlot: {
    alignItems: 'center',
    borderRadius: 10,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  primaryIconSlot: {
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
  },
  optionText: {
    flex: 1,
    justifyContent: 'center',
    minWidth: 0,
  },
  optionTitle: {
    fontSize: 17,
    fontWeight: '800',
  },
  optionDescription: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
  },
  primaryOptionTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
  },
  primaryOptionDescription: {
    color: 'rgba(255, 255, 255, 0.84)',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
  },
  errorBox: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  errorText: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  footer: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  footerText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  skipText: {
    fontSize: 15,
    fontWeight: '800',
  },
});
