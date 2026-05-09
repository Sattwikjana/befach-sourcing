# Global Shopper Android App

Android-first React Native app for Global Shopper.

This first version is a native shell around `https://www.globalshopper.in`, which keeps the mobile app fully connected to the same website, backend, products, cart, wishlist, checkout, order tracking, FAQ, legal pages, AI search, and photo search. No separate admin panel or catalog sync is required.

## Why this version first

- The website already has the full ecommerce flow.
- Product/category/pricing/order changes continue to come from the existing backend.
- Play Store delivery is faster than rebuilding every screen natively first.
- Native features such as Android back button, splash screen, deep links, camera permission for photo search, push-notification token registration, and app packaging are already in place.

## Run Locally

```bash
cd mobile
npm install
npm start
```

Then press `a` to open on an Android emulator, or scan the Expo QR in Expo Go.

## Build Android APK For Testing

```bash
cd mobile
npm install
npx eas login
npm run android:preview
```

This creates an internal testing APK.

## Build Play Store AAB

```bash
cd mobile
npm install
npx eas login
npm run android:build
```

Upload the generated `.aab` to Google Play Console.

## Play Store Readiness

- Privacy policy URL: `https://www.globalshopper.in/privacy`
- App package: `in.globalshopper.app`
- Production build format: Android App Bundle (`.aab`)
- Camera permission: used only for photo search.
- Notification permission: used for order/account updates when the customer allows notifications.
- Storage/media permissions are blocked because the app does not need broad file access.

## Package Details

- Android package: `in.globalshopper.app`
- App name: `Global Shopper`
- Website: `https://www.globalshopper.in`
- Deep links: `https://www.globalshopper.in/*`

## Next Native Upgrades

These can be added without changing the backend:

- Native camera/gallery photo search picker
- Push-notification sending from admin/order events
- Native bottom tab navigation
- Native product listing/detail screens using `/api/store/*`
- Native order tracking screen
- App-only coupons and campaigns
