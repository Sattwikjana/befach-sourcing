import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import * as SplashScreen from 'expo-splash-screen';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  BackHandler,
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

const APP_USER_AGENT = 'GlobalShopperAndroid/0.1.1';

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

export default function App() {
  const webViewRef = useRef<WebView>(null);
  const [currentUrl, setCurrentUrl] = useState(HOME_URL);
  const [canGoBack, setCanGoBack] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const injectedJavaScript = useMemo(() => `
    window.__GLOBAL_SHOPPER_APP__ = true;
    document.documentElement.classList.add('global-shopper-native-app');
    true;
  `, []);

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
        <View style={styles.webViewWrap}>
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
