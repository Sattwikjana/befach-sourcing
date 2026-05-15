import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  BackHandler,
  GestureResponderEvent,
  Platform,
  StatusBar as NativeStatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView, WebViewNavigation } from 'react-native-webview';

SplashScreen.preventAutoHideAsync().catch(() => {});

const DEFAULT_SITE_URL = 'https://www.globalshopper.in';
const SITE_URL = String(Constants.expoConfig?.extra?.siteUrl || DEFAULT_SITE_URL).replace(/\/+$/, '');
const HOME_URL = `${SITE_URL}/`;

const APP_VERSION = '0.1.2';
const APP_USER_AGENT = `GlobalShopperAndroid/${APP_VERSION}`;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false
  })
});

function toAppUrl(url: string | null | undefined) {
  if (!url) return HOME_URL;
  if (url.startsWith('globalshopper://')) {
    const parsed = Linking.parse(url);
    const path = parsed.path ? `/${String(parsed.path).replace(/^\/+/, '')}` : '/';
    const query = Object.entries(parsed.queryParams || {})
      .filter(([, value]) => value != null)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join('&');
    return `${SITE_URL}${path}${query ? `?${query}` : ''}`;
  }
  if (url.startsWith('/')) return `${SITE_URL}${url}`;
  return url;
}

function isGlobalShopperUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'www.globalshopper.in' || parsed.hostname === 'globalshopper.in';
  } catch {
    return false;
  }
}

function hasMultipleTouches(event: GestureResponderEvent) {
  return (event.nativeEvent.touches?.length || 0) > 1;
}

async function registerForPushNotificationsAsync() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('orders', {
      name: 'Order updates',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#0B5FFF'
    });
  }

  if (!Device.isDevice) return null;

  const existing = await Notifications.getPermissionsAsync();
  let finalStatus = existing.status;

  if (existing.status !== 'granted') {
    const requested = await Notifications.requestPermissionsAsync();
    finalStatus = requested.status;
  }

  if (finalStatus !== 'granted') return null;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
  if (!projectId) return null;

  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  return token.data;
}

export default function App() {
  const webViewRef = useRef<WebView>(null);
  const [currentUrl, setCurrentUrl] = useState(HOME_URL);
  const [canGoBack, setCanGoBack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushToken, setPushToken] = useState<string | null>(null);

  const injectedJavaScript = useMemo(() => `
    window.__GLOBAL_SHOPPER_APP__ = true;
    document.documentElement.classList.add('global-shopper-native-app');
    (function lockViewport() {
      var content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no, viewport-fit=cover';
      var styleId = 'global-shopper-native-viewport-lock';
      function apply() {
        var meta = document.querySelector('meta[name="viewport"]');
        if (!meta) {
          meta = document.createElement('meta');
          meta.setAttribute('name', 'viewport');
          (document.head || document.documentElement).appendChild(meta);
        }
        if (meta.getAttribute('content') !== content) meta.setAttribute('content', content);
        var style = document.getElementById(styleId);
        if (!style) {
          style = document.createElement('style');
          style.id = styleId;
          style.textContent = 'html.global-shopper-native-app, html.global-shopper-native-app body { touch-action: pan-x pan-y; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }';
          (document.head || document.documentElement).appendChild(style);
        }
      }
      function preventZoomGesture(event) {
        if (event.touches && event.touches.length > 1) event.preventDefault();
      }
      apply();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', apply);
      }
      try {
        var observer = new MutationObserver(apply);
        observer.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}
      document.addEventListener('touchstart', preventZoomGesture, { passive: false });
      document.addEventListener('touchmove', preventZoomGesture, { passive: false });
      document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
      document.addEventListener('gesturechange', function (e) { e.preventDefault(); }, { passive: false });
      document.addEventListener('gestureend', function (e) { e.preventDefault(); }, { passive: false });
    })();
    true;
  `, []);

  const injectPushToken = useCallback((token = pushToken) => {
    if (!token) return;
    const detail = {
      token,
      platform: Platform.OS,
      appVersion: APP_VERSION
    };
    webViewRef.current?.injectJavaScript(`
      window.__GLOBAL_SHOPPER_PUSH_TOKEN__ = ${JSON.stringify(token)};
      window.dispatchEvent(new CustomEvent('globalshopper:push-token', { detail: ${JSON.stringify(detail)} }));
      true;
    `);
  }, [pushToken]);

  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({ url }) => {
      const nextUrl = toAppUrl(url);
      setCurrentUrl(nextUrl);
      webViewRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(nextUrl)}; true;`);
    });
    Linking.getInitialURL().then(url => {
      if (url) setCurrentUrl(toAppUrl(url));
    }).catch(() => {});
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    let cancelled = false;
    registerForPushNotificationsAsync()
      .then(token => {
        if (!cancelled && token) setPushToken(token);
      })
      .catch(() => {});

    const subscription = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data || {};
      const target = typeof data.url === 'string'
        ? data.url
        : (typeof data.path === 'string' ? data.path : '');
      if (!target) return;
      const nextUrl = toAppUrl(target);
      setCurrentUrl(nextUrl);
      webViewRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(nextUrl)}; true;`);
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    injectPushToken();
  }, [injectPushToken]);

  useEffect(() => {
    const onBackPress = () => {
      if (canGoBack) {
        webViewRef.current?.goBack();
        return true;
      }
      if (currentUrl !== HOME_URL) {
        setCurrentUrl(HOME_URL);
        webViewRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(HOME_URL)}; true;`);
        return true;
      }
      return false;
    };
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => subscription.remove();
  }, [canGoBack, currentUrl]);

  useEffect(() => {
    const fallback = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
    }, 2500);
    return () => clearTimeout(fallback);
  }, []);

  const handleNavChange = useCallback((nav: WebViewNavigation) => {
    setCurrentUrl(nav.url || HOME_URL);
    setCanGoBack(nav.canGoBack);
    if (nav.loading) setError(null);
  }, []);

  const handleRetry = useCallback(() => {
    setError(null);
    webViewRef.current?.reload();
  }, []);

  return (
    <SafeAreaProvider>
      <NativeStatusBar backgroundColor="#0B5FFF" barStyle="light-content" translucent={false} />
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <View
          style={styles.webViewWrap}
          onStartShouldSetResponderCapture={hasMultipleTouches}
          onMoveShouldSetResponderCapture={hasMultipleTouches}
        >
          <WebView
            ref={webViewRef}
            source={{ uri: currentUrl }}
            style={styles.webView}
            applicationNameForUserAgent={APP_USER_AGENT}
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            javaScriptEnabled
            domStorageEnabled
            allowsBackForwardNavigationGestures
            mediaPlaybackRequiresUserAction={false}
            scalesPageToFit={false}
            setBuiltInZoomControls={false}
            setDisplayZoomControls={false}
            textZoom={100}
            minimumFontSize={0}
            injectedJavaScript={injectedJavaScript}
            injectedJavaScriptBeforeContentLoaded={injectedJavaScript}
            pullToRefreshEnabled
            onNavigationStateChange={handleNavChange}
            onLoadStart={() => {
              setError(null);
            }}
            onLoadProgress={event => {
              if ((event.nativeEvent.progress || 0) > 0.35) {
                SplashScreen.hideAsync().catch(() => {});
              }
            }}
            onLoadEnd={() => {
              SplashScreen.hideAsync().catch(() => {});
              injectPushToken();
            }}
            onError={event => {
              SplashScreen.hideAsync().catch(() => {});
              setError(event.nativeEvent.description || 'Could not load Global Shopper.');
            }}
            onShouldStartLoadWithRequest={request => {
              const url = request.url || '';
              if (!url || url === 'about:blank') return true;
              if (isGlobalShopperUrl(url)) return true;
              if (/^(mailto:|tel:|upi:|intent:|whatsapp:)/i.test(url)) {
                Linking.openURL(url).catch(() => Alert.alert('Cannot open link', url));
                return false;
              }
              Linking.openURL(url).catch(() => Alert.alert('Cannot open link', url));
              return false;
            }}
          />

          {error && (
            <View style={styles.errorPanel}>
              <Text style={styles.errorTitle}>Could not load Global Shopper</Text>
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0B5FFF'
  },
  webViewWrap: {
    flex: 1,
    backgroundColor: '#F4F7FF'
  },
  webView: {
    flex: 1,
    backgroundColor: '#F4F7FF'
  },
  errorPanel: {
    position: 'absolute',
    left: 18,
    right: 18,
    top: '32%',
    padding: 18,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E1E7F0',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8
  },
  errorTitle: {
    color: '#111827',
    fontSize: 17,
    fontWeight: '900',
    textAlign: 'center'
  },
  errorText: {
    color: '#707682',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 19
  },
  retryButton: {
    alignSelf: 'center',
    marginTop: 14,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#111827'
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontWeight: '900'
  }
});
