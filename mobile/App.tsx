import * as Google from 'expo-auth-session/providers/google';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import * as Speech from 'expo-speech';
import * as SplashScreen from 'expo-splash-screen';
import * as WebBrowser from 'expo-web-browser';

// Required by expo-auth-session — completes the auth flow when the
// system browser redirects back to the app. Safe to call at module
// scope (idempotent if already finished).
WebBrowser.maybeCompleteAuthSession();
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

const APP_VERSION = '0.2.1';

// Web Client ID for Google Sign-In, baked into the build. Public —
// Client IDs are not secrets. Pulled from app.json extras so it can
// be swapped without code changes.
const GOOGLE_WEB_CLIENT_ID =
  String(Constants.expoConfig?.extra?.googleWebClientId || '');
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

  // ── Google Sign-In native bridge ────────────────────────────────
  // Google blocks the regular GSI button inside Android WebView for
  // security reasons. So in the app, the web's "Continue with Google"
  // button posts a `GS_GOOGLE_SIGNIN_REQUEST` message instead of
  // running GSI inline; we open the system browser via
  // expo-auth-session, get the ID token back, and inject it into the
  // WebView, which then POSTs to /api/auth/google like the web flow.
  const [googleRequest, googleResponse, promptGoogleAsync] = Google.useAuthRequest({
    clientId: GOOGLE_WEB_CLIENT_ID,
    iosClientId: GOOGLE_WEB_CLIENT_ID,
    androidClientId: GOOGLE_WEB_CLIENT_ID,
    webClientId: GOOGLE_WEB_CLIENT_ID,
    scopes: ['profile', 'email', 'openid'],
  });

  useEffect(() => {
    if (!googleResponse) return;
    if (googleResponse.type === 'success') {
      // expo-auth-session returns an `id_token` for the OpenID Connect
      // flow. Inject into the WebView so the existing client-side
      // sign-in handler can POST it to /api/auth/google — same as
      // the web GSI flow on the server side.
      const idToken =
        (googleResponse as any)?.params?.id_token ||
        (googleResponse as any)?.authentication?.idToken ||
        '';
      if (idToken && webViewRef.current) {
        const safe = JSON.stringify(idToken);
        webViewRef.current.injectJavaScript(`
          (function () {
            try {
              if (typeof window.__handleGoogleSignInToken === 'function') {
                window.__handleGoogleSignInToken(${safe});
              } else if (typeof window.showToast === 'function') {
                window.showToast('Google sign-in handler not ready, please retry');
              }
            } catch (e) {}
          })();
          true;
        `);
      }
    } else if (googleResponse.type === 'error' || googleResponse.type === 'dismiss' || googleResponse.type === 'cancel') {
      // User dismissed or auth errored — let the WebView know so it
      // can re-enable the button. Silent if no toast available.
      webViewRef.current?.injectJavaScript(`
        (function () {
          try {
            if (typeof window.showToast === 'function') {
              window.showToast('Google sign-in was cancelled');
            }
          } catch (e) {}
        })();
        true;
      `);
    }
  }, [googleResponse]);

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
      // The web app is an SPA — every category / product / search /
      // cart navigation is a window.history.pushState() inside the
      // WebView. Android WebView's canGoBack() and goBack() track
      // *full page* navigations, not SPA pushState entries, so they
      // were returning false even after the user navigated several
      // screens deep — back press fell through and exited the app.
      //
      // Fix: inject JavaScript that uses the SPA's own window.history
      // (which DOES track every pushState). The injected script
      // decides:
      //   1. If we're on the home route ('/') → tell native side to
      //      exit the app (postMessage 'GS_BACK_EXIT').
      //   2. Else if window.history can go back → history.back().
      //   3. Else (deep-link entry, no history) → navigate to home.
      // We always return true here because the back press is being
      // handled inside the WebView; native should never auto-exit
      // unless the WebView explicitly requested it.
      webViewRef.current?.injectJavaScript(`
        (function () {
          try {
            // ── 1. Miki's chat panel takes precedence ──────────────
            // If the assistant is open, the back button should close
            // it BEFORE anything else (including the "press again to
            // exit" prompt on the home page). Pop our pushed history
            // state so the assistant's own popstate listener handles
            // the close cleanly. If for some reason no state was
            // pushed, fall back to clicking the X.
            var aiPanel = document.getElementById('aiPanel');
            if (aiPanel && aiPanel.classList.contains('is-open')) {
              if (window.history && window.history.state && window.history.state.aiPanel) {
                window.history.back();
              } else {
                var closeBtn = document.getElementById('aiPanelClose');
                if (closeBtn) closeBtn.click();
              }
              return;
            }

            // ── 2. Normal SPA back navigation ──────────────────────
            var path = (window.location.pathname || '/') +
                       (window.location.search || '') +
                       (window.location.hash || '');
            var isHome = path === '/' || path === '' || path === '/index.html';

            if (isHome) {
              // 3. Two-press-to-exit (Flipkart/Amazon pattern). First
              //    back press arms a 2-second timer + shows a toast.
              //    Second press within the window exits the app. The
              //    flag auto-clears so the customer can't accidentally
              //    exit on a stale back press an hour later.
              if (window.__gsPendingExit) {
                window.__gsPendingExit = false;
                if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
                  window.ReactNativeWebView.postMessage('GS_BACK_EXIT');
                }
                return;
              }
              window.__gsPendingExit = true;
              if (typeof window.showToast === 'function') {
                window.showToast('Press back again to exit', 1800);
              } else {
                var existing = document.getElementById('__gsExitToast');
                if (existing) existing.remove();
                var t = document.createElement('div');
                t.id = '__gsExitToast';
                t.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:rgba(15,6,40,0.92);color:#fff;padding:11px 20px;border-radius:24px;z-index:99999;font-size:14px;font-weight:600;box-shadow:0 12px 32px rgba(0,0,0,0.35);font-family:system-ui,-apple-system,sans-serif;letter-spacing:0.01em;animation:gsToastIn 200ms ease-out';
                t.textContent = 'Press back again to exit';
                document.body.appendChild(t);
                setTimeout(function(){
                  var el = document.getElementById('__gsExitToast');
                  if (el) el.remove();
                }, 1800);
              }
              clearTimeout(window.__gsPendingExitTimer);
              window.__gsPendingExitTimer = setTimeout(function () {
                window.__gsPendingExit = false;
              }, 2000);
              return;
            }

            // 4. Not home — pop one SPA history entry, or hard-redirect
            //    to home if there's nothing to pop (deep-link entry).
            if (window.history && window.history.length > 1) {
              window.history.back();
            } else {
              window.location.href = '/';
            }
          } catch (e) {
            window.location.href = '/';
          }
        })();
        true;
      `);
      return true;
    };
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => subscription.remove();
  }, []);

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
            /* v0.1.7: hand WebView permission requests (mic for the AI
               assistant's voice search, camera for "search by photo")
               back to the OS so users get the standard runtime prompt.
               Without this, the WebView silently denies every getUserMedia
               call. The browser's <input type=file> picker is handled
               separately by the WebView and already opens correctly
               once READ_MEDIA_IMAGES is in the manifest. */
            onPermissionRequest={(event: any) => {
              try {
                if (event?.grant && Array.isArray(event?.resources)) {
                  event.grant(event.resources);
                }
              } catch {}
            }}
            /* The Android picker for <input type="file"> needs these on
               to expose both Camera AND the Gallery. Without it some
               Android versions show only one of them, or block uploads
               entirely. */
            allowFileAccess
            allowFileAccessFromFileURLs
            allowUniversalAccessFromFileURLs
            allowsInlineMediaPlayback
            geolocationEnabled={false}
            scalesPageToFit={false}
            setBuiltInZoomControls={false}
            setDisplayZoomControls={false}
            textZoom={100}
            minimumFontSize={0}
            injectedJavaScript={injectedJavaScript}
            injectedJavaScriptBeforeContentLoaded={injectedJavaScript}
            // v0.1.6: Removed pullToRefreshEnabled because Android's
            // SwipeRefreshLayout was rendering a circular progress
            // indicator over the page during normal scrolling and
            // navigation — users were seeing it as a "loading screen
            // on top of the main screen" overlay (multiple reports).
            // The web app has its own skeleton + 'Loading products…'
            // hint, so we don't need the native pull-to-refresh UX too.
            pullToRefreshEnabled={false}
            // Explicitly tell the WebView NOT to render any default
            // loading view (startInLoadingState would render an
            // ActivityIndicator overlay otherwise on some platforms).
            startInLoadingState={false}
            renderLoading={() => <View />}
            // Hardware-accelerated rendering — smoother scrolling, no
            // intermediate paint that could resemble a loading state.
            androidLayerType="hardware"
            // Messages from the WebView's JS environment. The back-
            // button handler (in the useEffect above) posts
            // 'GS_BACK_EXIT' when the user presses back from the home
            // page — we exit gracefully so we don't sit on a screen
            // the user can't navigate further back from.
            onMessage={event => {
              const msg = event?.nativeEvent?.data;
              if (!msg) return;
              if (msg === 'GS_BACK_EXIT') {
                BackHandler.exitApp();
                return;
              }
              // Miki's text-to-speech bridge. Android WebView's
              // built-in speechSynthesis is unreliable (voices often
              // don't load, speak() fails silently). Hand it off to
              // expo-speech which uses the device's native TTS engine
              // and the locale's default female voice. Picks Indian
              // English where available.
              if (msg.startsWith('GS_SPEAK:')) {
                const text = msg.slice('GS_SPEAK:'.length);
                if (text) {
                  try { Speech.stop(); } catch {}
                  Speech.speak(text, {
                    language: 'en-IN',
                    rate: 0.96,
                    pitch: 1.05,
                  });
                }
                return;
              }
              if (msg === 'GS_SPEAK_STOP') {
                try { Speech.stop(); } catch {}
                return;
              }
              // Google Sign-In bridge — web pops this when the
              // customer taps "Continue with Google" inside the app.
              if (msg === 'GS_GOOGLE_SIGNIN_REQUEST') {
                if (!GOOGLE_WEB_CLIENT_ID) {
                  webViewRef.current?.injectJavaScript(`
                    if (typeof window.showToast === 'function') {
                      window.showToast('Google sign-in not configured in this build');
                    }
                    true;
                  `);
                  return;
                }
                if (googleRequest && promptGoogleAsync) {
                  promptGoogleAsync().catch(err => {
                    console.warn('[google] prompt failed:', err?.message);
                  });
                }
                return;
              }
            }}
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
