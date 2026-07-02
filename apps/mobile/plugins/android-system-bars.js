const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidColors,
  withAndroidColorsNight,
  withAndroidStyles,
} = require('@expo/config-plugins');

const SYSTEM_BAR_BACKGROUND = 'mindwtr_system_bar_background';
const LIGHT_BACKGROUND = '#F6F7FB';
const DARK_BACKGROUND = '#151718';
const APP_THEME = AndroidConfig.Styles.getAppThemeGroup();

const setSystemBarColor = (xml, color) =>
  AndroidConfig.Colors.assignColorValue(xml, {
    name: SYSTEM_BAR_BACKGROUND,
    value: color,
  });

const setStyleItem = (xml, name, value, targetApi) =>
  AndroidConfig.Styles.assignStylesValue(xml, {
    add: true,
    parent: APP_THEME,
    name,
    value,
    targetApi,
  });

const setSystemBarStyles = (xml) => {
  const colorRef = `@color/${SYSTEM_BAR_BACKGROUND}`;
  let next = setStyleItem(xml, 'android:statusBarColor', colorRef);
  next = setStyleItem(next, 'android:navigationBarColor', colorRef);
  next = setStyleItem(next, 'android:windowLightStatusBar', 'true', '23');
  next = setStyleItem(next, 'android:windowLightNavigationBar', 'true', '27');
  next = setStyleItem(next, 'android:enforceNavigationBarContrast', 'false', '29');
  return next;
};

const withAndroidSystemBars = (config) => {
  config = withAndroidColors(config, (cfg) => {
    cfg.modResults = setSystemBarColor(cfg.modResults, LIGHT_BACKGROUND);
    return cfg;
  });

  config = withAndroidColorsNight(config, (cfg) => {
    cfg.modResults = setSystemBarColor(cfg.modResults, DARK_BACKGROUND);
    return cfg;
  });

  config = withAndroidStyles(config, (cfg) => {
    cfg.modResults = setSystemBarStyles(cfg.modResults);
    return cfg;
  });

  return config;
};

module.exports = createRunOncePlugin(withAndroidSystemBars, 'mindwtr-android-system-bars', '1.0.0');

module.exports.__testables = {
  DARK_BACKGROUND,
  LIGHT_BACKGROUND,
  SYSTEM_BAR_BACKGROUND,
  setSystemBarColor,
  setSystemBarStyles,
};
