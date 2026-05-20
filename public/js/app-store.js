/**
 * Global Shopper — Cart, Checkout, Order, Track, Admin, FAQ pages.
 * Loaded after app.js; shares its globals (esc, fmtINR, apiGet, apiPost, state, cart helpers, etc.).
 */

'use strict';

// ══════════════════════════════════════════════════════════════
//  CART PAGE
// ══════════════════════════════════════════════════════════════
function renderAuthRequiredPage({ title = 'Sign in required', message = 'Please sign in to continue.', redirect = '/', primary = 'Sign in' } = {}) {
  app.innerHTML = `
    <div class="breadcrumb"><a href="/">Home</a> <span>›</span> <span class="current">${esc(title)}</span></div>
    <div class="empty-state">
      <div class="empty-icon" aria-hidden="true">🔐</div>
      <h3>${esc(title)}</h3>
      <p class="muted">${esc(message)}</p>
      <a class="btn btn-primary" href="/login?redirect=${encodeURIComponent(redirect)}">${esc(primary)}</a>
      <a class="btn btn-ghost" href="/">Continue shopping</a>
    </div>
  `;
}

function renderCart() {
  if (!state.user) return renderAuthRequiredPage({
    title: 'Sign in to view your cart',
    message: 'Your cart is saved to your Global Shopper account so it stays synced across devices.',
    redirect: '/cart'
  });
  const items = state.cart;

  if (!items.length) {
    app.innerHTML = `
      <div class="breadcrumb"><a href="/">Home</a> <span>›</span> <span class="current">Cart</span></div>
      <div class="empty-state">
        <div class="empty-icon">🛒</div>
        <h3>Your cart is empty</h3>
        <p class="muted">Add some products to get started.</p>
        <a class="btn btn-primary" href="/">Shop now</a>
      </div>`;
    return;
  }

  app.innerHTML = `
    <div class="breadcrumb"><a href="/">Home</a> <span>›</span> <span class="current">Cart</span></div>
    <h1 class="page-title">Your Cart</h1>
    <div class="cart-layout">
      <div class="cart-items" id="cartItems"></div>
      <aside class="cart-summary" id="cartSummary"></aside>
    </div>
  `;
  renderCartItems();
  renderCartSummary();

  // Sticky bottom CTA on mobile (CSS hides it on desktop)
  if (typeof installMobileCtaBar === 'function') {
    installMobileCtaBar({
      getPrice: () => cartSubtotalUsd(),
      getDisabled: () => state.cart.length === 0,
      onClick: () => navigate('/checkout'),
      label: 'Checkout →',
      priceLabel: 'Total (incl. shipping)',
    });
  }
}

function renderCartItems() {
  const container = document.getElementById('cartItems');
  if (!container) return;
  container.innerHTML = state.cart.map((item, idx) => `
    <div class="cart-item fade-in" data-idx="${idx}">
      <a href="/product/${encodeURIComponent(item.pid)}" class="cart-item-img-wrap">
        <img src="${imgProxy(item.image)}" alt="${esc(item.productName)}" width="96" height="96" loading="lazy" decoding="async" onerror="this.src='/img/globalshopper.png'"/>
      </a>
      <div class="cart-item-info">
        <a class="cart-item-title" href="/product/${encodeURIComponent(item.pid)}">${esc(item.productName)}</a>
        ${item.variantName ? `<div class="cart-item-variant">${esc(item.variantName)}</div>` : ''}
        <div class="cart-item-price">${fmtINR(item.priceUsd)}</div>
      </div>
      <div class="cart-item-qty">
        <button type="button" class="cart-qty-btn" aria-label="Decrease quantity for ${esc(item.productName)}" onclick="cartAdjust('${esc(item.pid)}','${esc(item.vid)}',-1)">−</button>
        <input type="number" min="1" value="${item.quantity}" aria-label="Quantity for ${esc(item.productName)}" onchange="cartSetQty('${esc(item.pid)}','${esc(item.vid)}', this.value)"/>
        <button type="button" class="cart-qty-btn" aria-label="Increase quantity for ${esc(item.productName)}" onclick="cartAdjust('${esc(item.pid)}','${esc(item.vid)}',1)">+</button>
      </div>
      <div class="cart-item-line">${fmtINR(parseFloat(item.priceUsd) * item.quantity)}</div>
      <button class="cart-item-remove" title="Remove" aria-label="Remove ${esc(item.productName)} from cart" onclick="cartRemove('${esc(item.pid)}','${esc(item.vid)}')">✕</button>
    </div>
  `).join('');
}

function renderCartSummary() {
  const sub = cartSubtotalUsd();

  const el = document.getElementById('cartSummary');
  if (!el) return;
  el.innerHTML = `
    <h3>Order summary</h3>
    <div class="summary-row"><span>Subtotal (${state.cart.length} ${state.cart.length === 1 ? 'item' : 'items'})</span><strong>${fmtINR(sub)}</strong></div>
    <div class="summary-row muted"><span>Shipping</span><span>Calculated at checkout</span></div>
    <div class="summary-row muted"><span>Taxes</span><span>Included</span></div>
    <hr/>
    <div class="summary-row summary-total"><span>Total</span><strong>${fmtINR(sub)}</strong></div>

    <button class="btn btn-primary btn-lg btn-full" onclick="navigate('/checkout')">Proceed to Checkout →</button>
    <a class="btn btn-ghost btn-full" href="/">Continue shopping</a>
    <button class="btn-link" onclick="if(confirm('Empty cart?')){clearCart();renderCart();}">Clear cart</button>
  `;
}

window.cartAdjust = function(pid, vid, delta) {
  const item = state.cart.find(i => i.pid === pid && i.vid === vid);
  if (!item) return;
  const newQty = item.quantity + delta;
  if (newQty <= 0) { removeFromCart(pid, vid); }
  else { updateCartQuantity(pid, vid, newQty); }
  renderCartItems(); renderCartSummary();
};
window.cartSetQty = function(pid, vid, qty) {
  updateCartQuantity(pid, vid, qty); renderCartItems(); renderCartSummary();
};
window.cartRemove = function(pid, vid) {
  removeFromCart(pid, vid); renderCart();
};

// ══════════════════════════════════════════════════════════════
//  CHECKOUT PAGE
// ══════════════════════════════════════════════════════════════
// Country → dialing-code map (mirrors server/orderManager.js so the UI
// shows the same prefix the server will normalize to).
const COUNTRY_DIAL_CODES_CLIENT = {
  IN: { code: '91',  localLen: 10 },
  US: { code: '1',   localLen: 10 },
  GB: { code: '44',  localLen: 10 },
  CN: { code: '86',  localLen: 11 },
  AE: { code: '971', localLen: 9 },
  AU: { code: '61',  localLen: 9 },
  CA: { code: '1',   localLen: 10 },
  DE: { code: '49',  localLen: 10 },
  SG: { code: '65',  localLen: 8 },
};

// If the user previously saved a phone WITH country code (e.g. "918008188807"),
// strip the prefix for display so they see just the 10-digit local part.
function stripCountryCode(phone, ccode = 'IN') {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  const cc = COUNTRY_DIAL_CODES_CLIENT[ccode];
  if (cc && digits.startsWith(cc.code) && digits.length === cc.code.length + cc.localLen) {
    return digits.slice(cc.code.length);
  }
  return digits;
}

async function renderCheckout() {
  if (!state.user) return renderAuthRequiredPage({
    title: 'Sign in to checkout',
    message: 'Please sign in before checkout so we can save your address, payment status and order tracking.',
    redirect: '/checkout'
  });
  // Two flows land here:
  //   • Buy Now → state.buyNowItem holds a single product (the rest
  //     of the cart is ignored on this page)
  //   • Cart → Checkout → renders state.cart as usual
  const isBuyNow = !!state.buyNowItem;
  const items = isBuyNow ? [state.buyNowItem] : state.cart;
  if (!items.length) {
    // Buy-now slot somehow emptied (qty fell to 0, item removed) —
    // send the user back to cart, which itself shows the empty state
    // if the cart is also empty.
    if (isBuyNow) clearBuyNowItem();
    return renderCart();
  }
  const subtotalUsd = () => items.reduce(
    (s, i) => s + (parseFloat(i.priceUsd) * (i.quantity || 1)),
    0
  );

  // Restore any previous address so customers don't re-type
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('befach_address') || '{}'); } catch {}
  // If signed in, prefer the user's profile fields and saved address
  if (state.user) {
    saved = {
      name: saved.name || state.user.name || '',
      email: saved.email || state.user.email || '',
      phone: saved.phone || state.user.phone || '',
      ...(state.user.address || {}),
      ...saved,
    };
  }
  // Phone shows just the local digits — the +XX prefix is rendered as a
  // visual chip next to the input (and the server adds it back on submit).
  const initialCC = saved.countryCode || state.config.shipTo || 'IN';
  saved.phone = stripCountryCode(saved.phone, initialCC);

  app.innerHTML = `
    <div class="breadcrumb">
      <a href="/">Home</a> <span>›</span>
      ${isBuyNow ? '' : '<a href="/cart">Cart</a> <span>›</span>'}
      <span class="current">Checkout${isBuyNow ? ' (Buy Now)' : ''}</span>
    </div>
    <h1 class="page-title">Checkout</h1>

    <div class="checkout-layout">
      <div class="checkout-main">
        <!-- Step 1: Address -->
        <section class="checkout-step">
          <h2><span class="step-num">1</span> Contact & shipping address</h2>
          <form id="checkoutForm" class="checkout-form">
            <div class="form-row">
              <label>Full name *<input name="name" required value="${esc(saved.name || '')}" /></label>
              <label>Phone *
                <div class="phone-input-wrap">
                  <span class="phone-cc" id="phoneCcPrefix">+91</span>
                  <input name="phone" type="tel" required
                         value="${esc(saved.phone || '')}"
                         placeholder="10-digit number"
                         inputmode="numeric" autocomplete="tel-national" />
                </div>
              </label>
            </div>
            <label>Email *<input name="email" type="email" required value="${esc(saved.email || '')}" /></label>
            <label>Address line 1 *<input name="address" required value="${esc(saved.address || '')}" /></label>
            <label>Address line 2<input name="address2" value="${esc(saved.address2 || '')}" /></label>
            <div class="form-row form-row-3">
              <label>City *<input name="city" required value="${esc(saved.city || '')}" /></label>
              <label>State / Province *<input name="province" required value="${esc(saved.province || '')}" /></label>
              <label>PIN / ZIP *<input name="zip" required value="${esc(saved.zip || '')}" /></label>
            </div>
            <label>Country *
              <select name="countryCode" id="checkoutCountry" required>
                <option value="IN" ${(saved.countryCode || state.config.shipTo) === 'IN' ? 'selected' : ''}>India</option>
                <option value="US" ${saved.countryCode === 'US' ? 'selected' : ''}>United States</option>
                <option value="GB" ${saved.countryCode === 'GB' ? 'selected' : ''}>United Kingdom</option>
                <option value="AE" ${saved.countryCode === 'AE' ? 'selected' : ''}>United Arab Emirates</option>
                <option value="AU" ${saved.countryCode === 'AU' ? 'selected' : ''}>Australia</option>
                <option value="CA" ${saved.countryCode === 'CA' ? 'selected' : ''}>Canada</option>
                <option value="DE" ${saved.countryCode === 'DE' ? 'selected' : ''}>Germany</option>
                <option value="SG" ${saved.countryCode === 'SG' ? 'selected' : ''}>Singapore</option>
              </select>
            </label>
            <!-- KYC for Indian customs clearance — required by CJ for India shipments.
                 Hidden for non-India destinations via JS below. -->
            <div class="form-kyc" id="kycFields">
              <label>Aadhaar or PAN *
                <input name="consigneeID" id="checkoutConsigneeID"
                       value="${esc(saved.consigneeID || '')}"
                       placeholder="12-digit Aadhaar or 10-character PAN"
                       maxlength="12" />
              </label>
              <p class="form-hint muted small">Required by Indian customs for international parcels. We never share this with anyone except the customs authority via our shipping partner.</p>
            </div>
          </form>
        </section>

        <!-- Step 2: Payment method -->
        <section class="checkout-step">
          <h2><span class="step-num">2</span> Payment method</h2>
          <div class="payment-method-card selected">
            <div class="pm-icon">💳</div>
            <div class="pm-body">
              <div class="pm-title">Pay Online (UPI · Cards · Netbanking · Wallets)</div>
              <p class="pm-sub">Secure payment powered by Razorpay. You'll see a popup to choose UPI, debit/credit card, netbanking or wallet.</p>
            </div>
            <div class="pm-tick">✓</div>
          </div>
        </section>
      </div>

      <!-- Order summary sidebar -->
      <aside class="cart-summary">
        <h3>Order summary</h3>
        <div class="checkout-items" id="checkoutItems"></div>
        <hr/>
        <div class="summary-row" id="sumSubtotalRow"><span id="sumSubtotalLabel">Subtotal (${items.length} ${items.length === 1 ? 'item' : 'items'})</span><strong id="sumSubtotal">${fmtINR(subtotalUsd())}</strong></div>
        <div class="summary-row muted"><span>Shipping</span><span>Included</span></div>
        <div class="summary-row muted"><span>Taxes</span><span>Included</span></div>
        <hr/>
        <div class="summary-row summary-total"><span>Total</span><strong id="sumTotal">${fmtINR(subtotalUsd())}</strong></div>
        <button class="btn btn-primary btn-lg btn-full" id="placeOrderBtn">Pay &amp; Place order</button>
        <p class="muted small" style="text-align:center">By placing this order you agree to our terms.</p>
      </aside>
    </div>
  `;

  trackEcommerceEvent('begin_checkout', {
    value: Math.round(subtotalUsd() * (state.config.usdToInr || 85)),
    items: items.map(analyticsItemFromCart)
  });

  // Render order-summary items WITH inline quantity controls and a
  // remove button. Same UX for cart-mode and buy-now mode; the
  // handlers branch internally.
  function renderCheckoutItems() {
    const list = checkoutItems();
    const host = document.getElementById('checkoutItems');
    if (!host) return;
    host.innerHTML = list.map(item => {
      const lineUsd = parseFloat(item.priceUsd) * (item.quantity || 1);
      return `
      <div class="checkout-item" data-pid="${esc(item.pid)}" data-vid="${esc(item.vid)}">
        <img src="${imgProxy(item.image)}" alt="${esc(item.productName)}" width="50" height="50" loading="lazy" decoding="async" onerror="this.src='/img/globalshopper.png'"/>
        <div class="checkout-item-info">
          <div class="checkout-item-title">${esc(item.productName.slice(0, 50))}${item.productName.length > 50 ? '…' : ''}</div>
          ${item.variantName ? `<div class="checkout-item-variant muted small">${esc(item.variantName)}</div>` : ''}
          <div class="checkout-item-controls">
            <div class="checkout-qty">
              <button type="button" class="checkout-qty-btn" aria-label="Decrease quantity" onclick="checkoutQtyChange('${esc(item.pid)}','${esc(item.vid)}',-1)">−</button>
              <span class="checkout-qty-num" aria-live="polite">${item.quantity || 1}</span>
              <button type="button" class="checkout-qty-btn" aria-label="Increase quantity" onclick="checkoutQtyChange('${esc(item.pid)}','${esc(item.vid)}',1)">+</button>
            </div>
            <button type="button" class="checkout-item-remove" aria-label="Remove ${esc(item.productName)}" onclick="checkoutRemoveItem('${esc(item.pid)}','${esc(item.vid)}')">✕</button>
          </div>
        </div>
        <div class="checkout-item-price">${fmtINR(lineUsd)}</div>
      </div>
    `;}).join('');
  }
  function refreshCheckoutSummary() {
    const list = checkoutItems();
    const sub = list.reduce((s, i) => s + parseFloat(i.priceUsd) * (i.quantity || 1), 0);
    const subEl = document.getElementById('sumSubtotal');
    const totalEl = document.getElementById('sumTotal');
    const labelEl = document.getElementById('sumSubtotalLabel');
    if (subEl) subEl.textContent = fmtINR(sub);
    if (totalEl) totalEl.textContent = fmtINR(sub);
    if (labelEl) labelEl.textContent = `Subtotal (${list.length} ${list.length === 1 ? 'item' : 'items'})`;
  }
  renderCheckoutItems();
  // Expose helpers so the inline onclick handlers above can find them
  // (these need to live on window because the HTML is injected as a
  // string). Defined fresh each render so they always close over the
  // latest mode (cart vs buy-now).
  window.checkoutQtyChange = function(pid, vid, delta) {
    if (state.buyNowItem) {
      if (state.buyNowItem.pid !== pid || state.buyNowItem.vid !== vid) return;
      const next = (state.buyNowItem.quantity || 1) + delta;
      if (next <= 0) return window.checkoutRemoveItem(pid, vid);
      setBuyNowItem({ ...state.buyNowItem, quantity: next });
    } else {
      const item = state.cart.find(i => i.pid === pid && i.vid === vid);
      if (!item) return;
      const next = (item.quantity || 1) + delta;
      if (next <= 0) return window.checkoutRemoveItem(pid, vid);
      updateCartQuantity(pid, vid, next);
      updateCartBadge();
    }
    renderCheckoutItems();
    refreshCheckoutSummary();
  };
  window.checkoutRemoveItem = function(pid, vid) {
    if (state.buyNowItem) {
      // Removing the single buy-now product means the express
      // checkout no longer has anything to charge for — fall back
      // to whichever next page makes sense.
      clearBuyNowItem();
      if (state.cart.length) {
        showToast('Removed. Returned to your cart.');
        navigate('/cart');
      } else {
        showToast('Removed.');
        navigate('/');
      }
      return;
    }
    removeFromCart(pid, vid);
    updateCartBadge();
    if (!state.cart.length) {
      showToast('Your cart is empty.');
      navigate('/cart');
      return;
    }
    renderCheckoutItems();
    refreshCheckoutSummary();
  };

  // Persist address as user types
  const form = document.getElementById('checkoutForm');
  form.addEventListener('input', () => {
    const fd = Object.fromEntries(new FormData(form).entries());
    localStorage.setItem('befach_address', JSON.stringify(fd));
  });

  // Hide the Aadhaar/PAN field when the destination isn't India.
  const countrySel = document.getElementById('checkoutCountry');
  const kyc = document.getElementById('kycFields');
  const kycInput = document.getElementById('checkoutConsigneeID');
  const phoneInput = form.querySelector('input[name="phone"]');
  const phoneCcPrefix = document.getElementById('phoneCcPrefix');

  function syncCountrySpecificFields() {
    const isIndia = countrySel.value === 'IN';
    // KYC field
    kyc.style.display = isIndia ? '' : 'none';
    if (kycInput) kycInput.required = isIndia;
    // Phone country-code prefix
    const cc = COUNTRY_DIAL_CODES_CLIENT[countrySel.value] || COUNTRY_DIAL_CODES_CLIENT.IN;
    phoneCcPrefix.textContent = '+' + cc.code;
    // Re-strip the existing phone in case the user changed country
    phoneInput.value = stripCountryCode(phoneInput.value, countrySel.value);
  }
  countrySel.addEventListener('change', syncCountrySpecificFields);
  syncCountrySpecificFields();

  // If the user pastes/types a number with the country code already in
  // it (a common mistake — "+91 80081 88807" or "918008188807"), strip
  // it on the fly so they only see/keep the 10-digit local part.
  phoneInput.addEventListener('input', () => {
    const cc = COUNTRY_DIAL_CODES_CLIENT[countrySel.value];
    if (!cc) return;
    let digits = phoneInput.value.replace(/[^\d]/g, '');
    if (digits.startsWith(cc.code) && digits.length > cc.localLen) {
      phoneInput.value = digits.slice(cc.code.length);
    }
  });

  // Validate Aadhaar (12 digits) or PAN (10 chars, e.g. ABCDE1234F).
  // Inline error message instead of using HTML5 pattern (gives us a
  // clearer hint for either format).
  function validateConsigneeID(val) {
    const v = (val || '').trim();
    if (/^\d{12}$/.test(v)) return { ok: true, kind: 'Aadhaar' };
    if (/^[A-Z]{5}\d{4}[A-Z]$/i.test(v)) return { ok: true, kind: 'PAN' };
    return { ok: false };
  }

  // Place order flow:
  //   1. Validate form
  //   2. POST /api/store/payment/create-order  → server creates a Razorpay
  //      order with the server-priced amount; returns ids + key
  //   3. Open Razorpay's checkout modal with those ids
  //   4. On success: POST /api/store/orders with the payment ids; server
  //      verifies signature + amount, saves order, pushes to CJ
  document.getElementById('placeOrderBtn').onclick = async () => {
    if (!form.reportValidity()) return;
    const fd = Object.fromEntries(new FormData(form).entries());

    // India-only validation: Aadhaar (12 digits) or PAN (e.g. ABCDE1234F)
    if (fd.countryCode === 'IN') {
      const check = validateConsigneeID(fd.consigneeID);
      if (!check.ok) {
        showToast('Please enter a valid 12-digit Aadhaar or 10-character PAN');
        kycInput?.focus();
        return;
      }
    }
    if (typeof window.Razorpay !== 'function') {
      showToast('Payment system still loading — please wait a few seconds and try again', 4500);
      return;
    }

    const btn = document.getElementById('placeOrderBtn');
    btn.disabled = true;
    btn.textContent = 'Starting payment…';

    // Use whichever item set is being checked out (cart OR buy-now)
    const checkoutList = checkoutItems();
    const itemsPayload = checkoutList.map(i => ({ pid: i.pid, vid: i.vid, quantity: i.quantity }));
    const shippingPayload = {
      address: fd.address,
      address2: fd.address2 || '',
      city: fd.city,
      province: fd.province,
      zip: fd.zip,
      country: countryName(fd.countryCode),
      countryCode: fd.countryCode,
    };
    const consigneeID = (fd.consigneeID || '').trim().toUpperCase();

    // Expected total paise — matches the server's USD→INR conversion so
    // a small ±2% drift (FX rounding, per-variant shipping refresh) is
    // tolerated, but real price changes (admin override, CJ wholesale
    // movement) trip a 409 PRICE_CHANGED on the server. Without this,
    // the customer would only learn about a price change inside the
    // Razorpay modal — too late and confusing.
    const usdToInr = state.config.usdToInr || 85;
    const expectedTotalPaise = Math.round(subtotalUsd() * usdToInr * 100);

    let intent;
    try {
      intent = await apiPost('/api/store/payment/create-order', {
        items: itemsPayload,
        expectedTotalPaise,
      });
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Pay & Place order';

      if (err.code === 'PRICE_CHANGED' && Array.isArray(err.data?.priced)) {
        // Update whichever item-set is being checked out (cart OR
        // buy-now) with the new server-side prices so the customer
        // sees the real total before they retry.
        const priceByVid = {};
        for (const p of err.data.priced) priceByVid[p.vid] = p.displayPrice;
        if (state.buyNowItem && priceByVid[state.buyNowItem.vid]) {
          setBuyNowItem({
            ...state.buyNowItem,
            priceUsd: String(priceByVid[state.buyNowItem.vid]),
          });
        } else {
          for (const item of state.cart) {
            if (priceByVid[item.vid]) item.priceUsd = String(priceByVid[item.vid]);
          }
          try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch {}
        }

        const oldInr = (expectedTotalPaise / 100).toFixed(0);
        const newInr = (err.data.actualTotalPaise / 100).toFixed(0);
        showToast(`Prices updated since you opened your cart — old ₹${oldInr}, new ₹${newInr}. Review and tap Pay again.`, 7000);
        // Re-render the checkout list + summary so the new total shows.
        renderCheckoutItems();
        refreshCheckoutSummary();
        updateCartBadge();
        return;
      }

      showToast('Could not start payment: ' + err.message, 4500);
      return;
    }

    btn.textContent = 'Awaiting payment…';

    const rzp = new Razorpay({
      key: intent.keyId,
      amount: intent.amount,
      currency: intent.currency || 'INR',
      order_id: intent.razorpayOrderId,
      name: 'Global Shopper',
      description: `${itemsPayload.length} item${itemsPayload.length === 1 ? '' : 's'} from Global Shopper`,
      // Razorpay shows this image at the top of the checkout modal.
      image: `${location.origin}/img/globalshopper.png`,
      prefill: {
        name: fd.name,
        email: fd.email,
        contact: fd.phone,
      },
      theme: { color: '#0A0A0A' },
      modal: {
        ondismiss: () => {
          btn.disabled = false;
          btn.textContent = 'Pay & Place order';
        },
      },
      handler: async (rzResp) => {
        // Razorpay returns { razorpay_payment_id, razorpay_order_id, razorpay_signature }
        btn.textContent = 'Confirming order…';
        try {
          const res = await apiPost('/api/store/orders', {
            customer: { name: fd.name, phone: fd.phone, email: fd.email },
            items: itemsPayload,
            shippingAddress: shippingPayload,
            consigneeID,
            logisticName: state.config.shippingMethod || 'CJPacket Asia Ordinary',
            razorpay_payment_id: rzResp.razorpay_payment_id,
            razorpay_order_id: rzResp.razorpay_order_id,
            razorpay_signature: rzResp.razorpay_signature,
          });
          if (res.success && res.order) {
            const purchasedItems = checkoutItems();
            const purchasedValueInr = Math.round(
              purchasedItems.reduce((s, i) => s + parseFloat(i.priceUsd) * (i.quantity || 1), 0)
              * (state.config.usdToInr || 85)
            );
            trackEcommerceEvent('purchase', {
              transaction_id: res.order.id,
              value: purchasedValueInr,
              items: purchasedItems.map(analyticsItemFromCart)
            });
            // Save address to user profile (best-effort)
            if (state.user) {
              authPatch('/api/auth/me', {
                phone: fd.phone,
                address: { ...shippingPayload },
              }).catch(() => {});
            }
            // Clear only the slot that was actually used. Buy-now
            // orders leave the cart intact so the customer doesn't
            // lose what they had saved before the express purchase.
            if (isBuyNow) {
              clearBuyNowItem();
            } else {
              clearCart();
            }
            navigate(`/order/${res.order.id}`);
          } else {
            throw new Error(res.error || 'Order failed');
          }
        } catch (err) {
          // ⚠️ Money was captured but our backend couldn't create the order.
          // Show a clear message — admin needs to follow up via Razorpay
          // payment id (which is in the customer's email confirmation).
          showToast(
            `Payment received but order failed: ${err.message}. Reference: ${rzResp.razorpay_payment_id}. Please contact support.`,
            10000
          );
          btn.disabled = false;
          btn.textContent = 'Pay & Place order';
        }
      },
    });

    rzp.on('payment.failed', (resp) => {
      showToast('Payment failed: ' + (resp.error?.description || 'unknown'), 5000);
      btn.disabled = false;
      btn.textContent = 'Pay & Place order';
    });

    rzp.open();
  };
}

function countryName(code) {
  const m = { IN: 'India', US: 'United States', GB: 'United Kingdom', AE: 'UAE', AU: 'Australia', CA: 'Canada', DE: 'Germany', SG: 'Singapore' };
  return m[code] || code;
}

// ══════════════════════════════════════════════════════════════
//  ORDER DETAIL / CONFIRMATION
// ══════════════════════════════════════════════════════════════
async function renderOrderDetail(orderId) {
  app.innerHTML = `<div class="loading-wrap"><div class="spinner"></div><p>Loading order…</p></div>`;
  try {
    const r = await apiGet(`/api/store/orders/${encodeURIComponent(orderId)}`);
    const o = r.order;
    const tracking = r.tracking;
    if (!o) throw new Error('Order not found');

    app.innerHTML = `
      <div class="breadcrumb"><a href="/">Home</a> <span>›</span> <span class="current">Order ${esc(o.id)}</span></div>

      <div class="order-success-banner">
        <div class="order-success-icon">✅</div>
        <div>
          <h2>Thank you! Your order is placed.</h2>
          <p class="muted">We'll email a confirmation to <strong>${esc(o.customer?.email || 'you')}</strong>. Save your order ID to track progress.</p>
        </div>
      </div>

      <div class="order-detail">
        <div class="order-detail-main">
          <section class="card">
            <h3>Order #${esc(o.id)}</h3>
            <div class="order-status-row">
              <span class="status-chip status-${esc((o.status || 'PENDING').toLowerCase())}">${esc(o.status)}</span>
              ${o.cjStatus ? `<span class="muted">Supplier: ${esc(o.cjStatus)}</span>` : ''}
            </div>
            <div class="muted small">Placed ${new Date(o.createdAt).toLocaleString('en-IN')}</div>
          </section>

          <section class="card">
            <h3>Items</h3>
            ${o.items.map(i => {
              const unit = parseFloat(i.unitPrice || i.retailPrice || 0);
              return `
              <div class="order-item">
                <div class="order-item-info">
                  <div class="order-item-title">${esc(i.productName)}</div>
                  ${i.variantName ? `<div class="muted small">${esc(i.variantName)}</div>` : ''}
                  <div class="muted small">Qty ${i.quantity}</div>
                </div>
                <div class="order-item-price">${fmtINR(unit * i.quantity)}</div>
              </div>
            `;}).join('')}
            <hr/>
            <div class="order-total-row"><span>Order total (incl. shipping)</span><strong>${fmtINR(o.grandTotal || o.productTotal)}</strong></div>
          </section>

          <section class="card">
            <h3>Shipping address</h3>
            <div>
              ${esc(o.shippingAddress.address)}${o.shippingAddress.address2 ? '<br/>' + esc(o.shippingAddress.address2) : ''}<br/>
              ${esc(o.shippingAddress.city)}, ${esc(o.shippingAddress.province)} ${esc(o.shippingAddress.zip)}<br/>
              ${esc(o.shippingAddress.country)}
            </div>
            ${o.logisticName ? `<div class="muted small" style="margin-top:8px">Method: ${esc(o.logisticName)}</div>` : ''}
          </section>

          ${tracking && tracking.events?.length ? `
            <section class="card">
              <h3>Tracking — ${esc(tracking.trackNumber)}</h3>
              <div class="tracking-timeline">
                ${tracking.events.slice(0, 20).map((ev, i) => `
                  <div class="tracking-event ${i === 0 ? 'first' : ''}">
                    <div class="tracking-dot"></div>
                    <div>
                      <div>${esc(ev.description || ev.status || 'Update')}</div>
                      <div class="muted small">${esc(ev.date || ev.eventTime || '')}${ev.location ? ' · ' + esc(ev.location) : ''}</div>
                    </div>
                  </div>
                `).join('')}
              </div>
            </section>
          ` : `
            <section class="card">
              <h3>Tracking</h3>
              <p class="muted">Tracking information will appear here once your order ships.</p>
            </section>
          `}
        </div>

        <aside class="order-detail-side">
          <div class="card">
            <h3>Need help?</h3>
            <a class="btn btn-ghost btn-full" href="mailto:support@befach.com">✉️ Email support</a>
            <a class="btn btn-ghost btn-full" href="/track">🔎 Track another order</a>
            <a class="btn btn-primary btn-full" href="/">Continue shopping</a>
          </div>
        </aside>
      </div>
    `;
  } catch (err) {
    app.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>Order not found</h3><p class="muted">${esc(err.message)}</p><a class="btn btn-primary" href="/">Home</a></div>`;
  }
}

// ══════════════════════════════════════════════════════════════
//  TRACK PAGE (enter an order ID)
// ══════════════════════════════════════════════════════════════
function renderTrack() {
  app.innerHTML = `
    <div class="breadcrumb"><a href="/">Home</a> <span>›</span> <span class="current">Track order</span></div>
    <div class="track-box">
      <h1>Track your order</h1>
      <p class="muted">Enter the order ID you received after checkout (e.g. BF-ABC123-XYZ9).</p>
      <form id="trackForm" class="track-form">
        <input type="text" name="id" placeholder="BF-..." required />
        <button class="btn btn-primary" type="submit">Track</button>
      </form>
    </div>
  `;
  document.getElementById('trackForm').onsubmit = (e) => {
    e.preventDefault();
    const id = (new FormData(e.target).get('id') || '').toString().trim();
    if (!id) return;
    navigate(`/order/${encodeURIComponent(id)}`);
  };
}

// ══════════════════════════════════════════════════════════════
//  ABOUT / LEGAL / COMPANY DETAILS
//  Public page that exposes company registration, GSTIN, IEC, CIN
//  and contact info. Surfaced in the footer; helps establish
//  legitimacy with payment processors and CJ verification.
// ══════════════════════════════════════════════════════════════
function renderAbout() {
  const c = window.COMPANY_INFO || {};
  app.innerHTML = `
    <div class="breadcrumb"><a href="/">Home</a> <span>›</span> <span class="current">About us</span></div>
    <section class="about-page">
      <div class="about-hero-card">
        <span class="about-kicker">${esc(c.brandTagline || 'One World. Endless Choices.')}</span>
        <h1>About ${esc(c.brandName || 'Global Shopper')}</h1>
        <p>We curate premium products from artisans, ateliers and verified suppliers across 200+ countries, then deliver them to customers in India with clear pricing and support.</p>
      </div>

      <div class="about-feature-grid">
        <article>
          <strong>200+ countries</strong>
          <span>Global catalog sourced through verified supplier networks.</span>
        </article>
        <article>
          <strong>10–15 day delivery</strong>
          <span>Tracked international delivery for eligible products.</span>
        </article>
        <article>
          <strong>Shipping included</strong>
          <span>Product prices are shown with India shipping included.</span>
        </article>
        <article>
          <strong>Human support</strong>
          <span>Help for orders, returns, refunds and product questions.</span>
        </article>
      </div>

      <section class="about-card">
        <h2>Operating entity</h2>
        <dl class="about-details">
          <div><dt>Legal name</dt><dd>${esc(c.legalName || '—')}</dd></div>
          <div><dt>Registered office</dt><dd>${esc(c.registeredAddress || '—')}</dd></div>
          <div><dt>GSTIN</dt><dd>${esc(c.gstin || '—')}</dd></div>
          <div><dt>IEC</dt><dd>${esc(c.iec || '—')}</dd></div>
        </dl>
      </section>

      <section class="about-card">
        <h2>Need help?</h2>
        <div class="about-link-grid">
          <a href="/track">Track order</a>
          <a href="/faq">Shipping &amp; returns</a>
          <a href="/returns">Returns &amp; refunds</a>
          <a href="/privacy">Privacy policy</a>
          <a href="/legal">Legal &amp; compliance</a>
          <a href="mailto:${esc(c.email || 'sales@befach.com')}">Contact support</a>
        </div>
      </section>
    </section>
  `;
}

function renderLegal() {
  const c = window.COMPANY_INFO || {};
  app.innerHTML = `
    <div class="breadcrumb"><a href="/">Home</a> <span>›</span> <span class="current">Legal &amp; Compliance</span></div>
    <h1 class="page-title">Legal &amp; Compliance</h1>

    <div class="legal-page">
      <section class="legal-section">
        <h2>About ${esc(c.brandName || 'Global Shopper')}</h2>
        <p><strong>${esc(c.brandName || 'Global Shopper')}</strong> is operated by ${esc(c.legalName || 'BEFACH 4X PRIVATE LIMITED')}, a cross-border e-commerce platform that curates premium products from artisans, ateliers, and verified manufacturers in 200+ countries and delivers them to your doorstep in India in 10–15 days. We are an authorised CJ Dropshipping partner (User ID: <strong>${esc(c.cjUserId || '—')}</strong>).</p>
      </section>

      <section class="legal-section">
        <h2>Company details</h2>
        <table class="legal-table">
          <tbody>
            <tr><th>Legal name</th><td>${esc(c.legalName || '—')}</td></tr>
            <tr><th>Brand name</th><td>${esc(c.brandName || '—')}</td></tr>
            <tr><th>Registered office</th><td>${esc(c.registeredAddress || '—')}</td></tr>
            <tr><th>GSTIN</th><td>${esc(c.gstin || '—')}</td></tr>
            <tr><th>Import &amp; Export Code (IEC)</th><td>${esc(c.iec || '—')}</td></tr>
            <tr><th>Founded</th><td>${esc(c.founded || '—')}</td></tr>
          </tbody>
        </table>
      </section>

      <section class="legal-section">
        <h2>Contact</h2>
        <p>
          📧 <a href="mailto:${esc(c.email || '')}">${esc(c.email || '')}</a><br/>
          📞 <a href="tel:${esc((c.phone || '').replace(/\s+/g, ''))}">${esc(c.phone || '')}</a><br/>
          🌐 <a href="${esc(c.website || '#')}" target="_blank" rel="noopener">${esc(c.website || '')}</a>
        </p>
      </section>

      <section class="legal-section">
        <h2>Shipping &amp; supplier policy</h2>
        <p>Products listed on this store are sourced from CJ Dropshipping's verified supplier network. Orders placed on ${esc(c.brandName || 'Global Shopper')} are forwarded to CJ for fulfillment via their official Store Orders API (<code>/shopping/order/createOrderV2</code>). We are responsible for customer service, payments, and warranty handling on the storefront side; CJ handles supplier coordination, packaging and international logistics.</p>
      </section>

      <section class="legal-section">
        <h2>Returns &amp; refunds</h2>
        <p>For shipping times, return windows and refund process, please see our <a href="/faq">Shipping &amp; FAQ</a>.</p>
      </section>

      <p class="legal-footer-note muted">Last updated: ${new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════
//  PRIVACY POLICY
//  Required for Play Console listing and payment/analytics review.
// ══════════════════════════════════════════════════════════════
function renderPrivacy() {
  const c = window.COMPANY_INFO || {};
  const email = c.email || 'sales@befach.com';
  const phone = c.phone || '+91 70570 53160';
  app.innerHTML = `
    <div class="breadcrumb"><a href="/">Home</a> <span>›</span> <span class="current">Privacy Policy</span></div>
    <h1 class="page-title">Privacy Policy</h1>

    <div class="legal-page">
      <section class="legal-section">
        <h2>Who we are</h2>
        <p>${esc(c.brandName || 'Global Shopper')} is operated by ${esc(c.legalName || 'BEFACH 4X PRIVATE LIMITED')}. This policy explains how we collect, use, store and share information when you use our website, Android app, customer account, checkout, search, wishlist, cart, order tracking and support services.</p>
        <p class="muted">Effective date: May 9, 2026</p>
      </section>

      <section class="legal-section">
        <h2>Information we collect</h2>
        <p>We collect account and contact details such as name, email address, phone number and login information; shipping and order details such as delivery address, product choices, cart, wishlist, return requests and order status; payment status and transaction references from Razorpay; support messages you send us; and app/device information such as app version, platform, notification token, browser user agent, diagnostics and analytics events.</p>
        <p>If you use photo search, the uploaded image may be processed to understand the product you are looking for. We use it only for search and support of that request.</p>
      </section>

      <section class="legal-section">
        <h2>How we use information</h2>
        <p>We use your information to create and secure your account, keep your cart and wishlist synced, process checkout, arrange international fulfilment, provide order tracking, send order notifications, respond to support requests, prevent fraud, improve product discovery and comply with tax, customs, legal and payment requirements.</p>
      </section>

      <section class="legal-section">
        <h2>Payments and fulfilment partners</h2>
        <p>Payments are processed by Razorpay. We do not store card, UPI or net-banking credentials. We may share only the information needed to complete your purchase with payment processors, CJ Dropshipping, suppliers, logistics providers, customs partners and customer-support tools.</p>
      </section>

      <section class="legal-section">
        <h2>Analytics, advertising and notifications</h2>
        <p>We use analytics and advertising tools such as Google Tag Manager and Meta Pixel to understand visits, improve campaigns and measure store performance. In the Android app we may collect an Expo push notification token so we can send order and account updates if you allow notifications.</p>
      </section>

      <section class="legal-section" id="delete">
        <h2>Account and data deletion</h2>
        <p>You can request account deletion or correction by emailing <a href="mailto:${esc(email)}">${esc(email)}</a>. We will delete or anonymise account data that is no longer needed, except records we must keep for tax, payment, fraud-prevention, order fulfilment, dispute or legal reasons.</p>
      </section>

      <section class="legal-section">
        <h2>Security and retention</h2>
        <p>We use reasonable technical and organisational safeguards to protect customer data. We retain information for as long as needed to provide the service, support orders and returns, meet legal obligations and protect the store from abuse.</p>
      </section>

      <section class="legal-section">
        <h2>Children</h2>
        <p>Our services are not intended for children under 13. If you believe a child has provided personal data, contact us and we will take appropriate action.</p>
      </section>

      <section class="legal-section">
        <h2>Contact</h2>
        <p>
          Email: <a href="mailto:${esc(email)}">${esc(email)}</a><br/>
          Phone: <a href="tel:${esc(phone.replace(/\s+/g, ''))}">${esc(phone)}</a><br/>
          Registered office: ${esc(c.registeredAddress || '')}
        </p>
      </section>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════
//  FAQ / SHIPPING & RETURNS
// ══════════════════════════════════════════════════════════════
function renderFaq() {
  app.innerHTML = `
    <div class="breadcrumb"><a href="/">Home</a> <span>›</span> <span class="current">Shipping & FAQ</span></div>
    <h1 class="page-title">Shipping, Returns & FAQ</h1>
    <div class="faq">
      <details open>
        <summary>How long does shipping take?</summary>
        <p>Delivery times vary by destination and shipping method. Most international orders arrive in 7–20 business days. You can see an estimate on the product page and during checkout.</p>
      </details>
      <details>
        <summary>Do you ship worldwide?</summary>
        <p>Yes. We ship to 200+ countries through multiple logistics partners. Available methods and rates are shown at checkout once you enter an address.</p>
      </details>
      <details>
        <summary>How do I track my order?</summary>
        <p>Go to <a href="/track">Track order</a> and enter the order ID you received after checkout. Tracking updates appear automatically once your package ships.</p>
      </details>
      <details>
        <summary>What is your return policy?</summary>
        <p>If an item arrives damaged or not as described, email <a href="mailto:support@befach.com">support@befach.com</a> within 7 days of delivery with photos, and we'll arrange a replacement or refund.</p>
      </details>
      <details>
        <summary>How does payment work?</summary>
        <p>Online payment is not yet enabled. After you place an order, our team will contact you to arrange payment. Your order is not charged until confirmed.</p>
      </details>
      <details>
        <summary>Are taxes and duties included?</summary>
        <p>Prices are inclusive of GST where applicable. Import duties for international shipments may be collected by your local customs; those are the buyer's responsibility.</p>
      </details>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════
//  ADMIN DASHBOARD
// ══════════════════════════════════════════════════════════════
const ADMIN_PW_KEY = 'befach_admin_pw';

function getAdminPw() { try { return sessionStorage.getItem(ADMIN_PW_KEY) || ''; } catch { return ''; } }
function setAdminPw(pw) { try { sessionStorage.setItem(ADMIN_PW_KEY, pw); } catch {} }
function clearAdminPw() { try { sessionStorage.removeItem(ADMIN_PW_KEY); } catch {} }

async function adminFetch(path) {
  const pw = getAdminPw();
  const res = await fetch(path, { headers: { 'x-admin-password': pw } });
  if (res.status === 401) { clearAdminPw(); throw new Error('Unauthorized'); }
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}
async function adminPost(path, body) {
  const pw = getAdminPw();
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { clearAdminPw(); throw new Error('Unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `API ${res.status}`);
  return data;
}

// ── Admin: Catalog & Shipping ops tile ──────────────────────────────
// Pulls /api/admin/catalog/status (single call, also includes shipping
// cache stats + app version). While a sync is running we poll every
// 4 s so the admin sees `phase` / `seen` advance in real time.
let __adminCatalogPollTimer = null;

function fmtAdminDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function fmtAdminBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

async function loadAdminCatalogStatus() {
  const statsEl = document.getElementById('adminCatalogStats');
  const jobEl = document.getElementById('adminCatalogJob');
  const verEl = document.getElementById('adminCatalogVersion');
  const syncBtn = document.getElementById('adminCatalogSyncBtn');
  const stopBtn = document.getElementById('adminCatalogStopBtn');
  if (!statsEl) return;
  try {
    const s = await adminFetch('/api/admin/catalog/status');
    if (verEl) verEl.textContent = s.appVersion ? `v${s.appVersion}` : '';
    const ship = s.shippingCache || {};
    const products = (typeof s.products === 'number')
      ? s.products.toLocaleString('en-IN')
      : '~' + Math.round((s.sizeBytes || 0) / 1700).toLocaleString('en-IN');
    const lastSync = s.lastSyncAt
      ? fmtAdminDuration(Date.now() - new Date(s.lastSyncAt).getTime())
      : 'never';
    statsEl.innerHTML = `
      <div class="stat-card"><div class="stat-label">Local catalog</div><div class="stat-value">${esc(products)}</div><div class="stat-label">products on disk</div></div>
      <div class="stat-card"><div class="stat-label">Disk size</div><div class="stat-value">${esc(fmtAdminBytes(s.sizeBytes))}</div><div class="stat-label">${esc(s.dbPath || '')}</div></div>
      <div class="stat-card"><div class="stat-label">Last sync</div><div class="stat-value">${esc(lastSync)}</div><div class="stat-label">global p${s.globalPage || 0} · cat ${s.categoryIndex || 0}/p${s.categoryPage || 0}</div></div>
      <div class="stat-card"><div class="stat-label">Shipping cache</div><div class="stat-value">${esc((ship.priced || 0).toLocaleString('en-IN'))} <span class="muted small">/ ${esc((ship.total || 0).toLocaleString('en-IN'))}</span></div><div class="stat-label">priced / total · ${esc(fmtAdminBytes(ship.sizeBytes || 0))}</div></div>
    `;
    const j = s.job || {};
    const running = !!j.running;
    if (jobEl) {
      if (running) {
        jobEl.innerHTML = `<strong>Sync running</strong> · phase <code>${esc(j.phase || '—')}</code> · ${j.calls || 0} API calls · ${j.seen || 0} seen · ${j.upserted || 0} upserted${j.skipped ? ` · ${j.skipped} skipped` : ''}${j.lastWarning ? ` · last warning: ${esc(j.lastWarning)}` : ''}`;
      } else if (j.phase === 'done' || j.phase === 'stopped' || j.phase === 'failed') {
        jobEl.innerHTML = `Last run: <code>${esc(j.phase)}</code> · ${j.calls || 0} calls · ${j.upserted || 0} upserted${j.error ? ` · error: ${esc(j.error)}` : ''}`;
      } else if (j.phase === 'disabled') {
        jobEl.textContent = 'Catalog sync disabled (CATALOG_SYNC_DISABLED env).';
      } else {
        jobEl.textContent = 'Sync idle.';
      }
    }
    if (syncBtn) {
      syncBtn.disabled = running;
      syncBtn.textContent = running ? 'Syncing…' : 'Sync now';
    }
    if (stopBtn) stopBtn.hidden = !running;
    // Poll while running so progress numbers advance live.
    if (__adminCatalogPollTimer) { clearTimeout(__adminCatalogPollTimer); __adminCatalogPollTimer = null; }
    if (running) {
      __adminCatalogPollTimer = setTimeout(loadAdminCatalogStatus, 4000);
    }
  } catch (err) {
    if (err.message === 'Unauthorized') return renderAdminLogin();
    statsEl.innerHTML = `<p class="muted">Failed to load: ${esc(err.message)}</p>`;
  }
}

async function adminStartCatalogSync() {
  const syncBtn = document.getElementById('adminCatalogSyncBtn');
  if (!syncBtn || syncBtn.disabled) return;
  if (!confirm('Start a CONTINUOUS catalog sync? It will keep crawling CJ pages (~3,000 calls/hour) until you click Stop sync, or the entire catalog is up-to-date. Bypasses CATALOG_SYNC_DISABLED for this operator-initiated run.')) return;
  syncBtn.disabled = true;
  syncBtn.textContent = 'Starting…';
  try {
    // force:true bypasses the CATALOG_SYNC_DISABLED kill-switch.
    // targetProducts / maxCalls set to effectively unlimited so the
    // sync only ends when the operator hits Stop sync, or when every
    // category rotation comes back dry (catalog fully fresh).
    const r = await adminPost('/api/admin/catalog/sync', {
      force: true,
      targetProducts: 100000000,
      maxCalls: 100000000,
    });
    if (r && r.started === false) {
      const why = r.disabled ? 'still blocked by server' : (r.job?.running ? 'already running' : 'unknown');
      alert(`Sync did not start (${why}). Status: ${JSON.stringify(r).slice(0, 200)}`);
    }
    loadAdminCatalogStatus();
  } catch (err) {
    alert('Sync failed to start: ' + err.message);
    syncBtn.disabled = false;
    syncBtn.textContent = 'Sync now';
  }
}

async function adminStopCatalogSync() {
  const stopBtn = document.getElementById('adminCatalogStopBtn');
  if (!stopBtn) return;
  stopBtn.disabled = true;
  try {
    await adminPost('/api/admin/catalog/sync/stop', {});
    loadAdminCatalogStatus();
  } catch (err) {
    alert('Stop request failed: ' + err.message);
  } finally {
    stopBtn.disabled = false;
  }
}

async function renderAdmin() {
  if (!getAdminPw()) return renderAdminLogin();

  app.innerHTML = `
    <div class="breadcrumb"><a href="/">Home</a> <span>›</span> <span class="current">Admin</span></div>
    <div class="admin-header">
      <h1>Admin Dashboard</h1>
      <button class="btn btn-ghost" onclick="adminLogout()">Sign out</button>
    </div>
    <div id="adminStats" class="admin-stats">Loading…</div>
    <div class="admin-grid">
      <section class="card">
        <h2>Recent orders</h2>
        <div id="adminOrders">Loading…</div>
      </section>
      <section class="card">
        <h2>Pricing</h2>
        <div id="adminPricing">Loading…</div>
      </section>
      <section class="card">
        <h2>CJ Balance</h2>
        <div id="adminBalance">Loading…</div>
      </section>
    </div>

    <!-- Catalog & Shipping ops tile.
         Sourced from /api/admin/catalog/status (single call also includes
         shipping cache stats + app version). The "Sync now" button is a
         POST to /api/admin/catalog/sync which kicks off a background
         pagination through CJ to refresh the local SQLite catalog.
         While a sync is running we auto-poll the status every 4 s.
         Buttons use inline onclick to match the rest of the admin panel
         (window.adminStartCatalogSync etc) — bulletproof against any
         render-order edge case where addEventListener might miss. -->
    <section class="card" style="margin-top:18px">
      <div class="card-head-row">
        <h2>Catalog &amp; Shipping <span class="muted small" id="adminCatalogVersion"></span></h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button id="adminCatalogRefreshBtn" class="btn btn-ghost btn-sm" type="button" onclick="loadAdminCatalogStatus()">Refresh</button>
          <button id="adminCatalogSyncBtn" class="btn btn-primary btn-sm" type="button" onclick="adminStartCatalogSync()">Sync now</button>
          <button id="adminCatalogStopBtn" class="btn btn-ghost btn-sm" type="button" onclick="adminStopCatalogSync()" hidden>Stop sync</button>
        </div>
      </div>
      <div id="adminCatalogStats" class="admin-catalog-grid">Loading…</div>
      <div id="adminCatalogJob" class="muted small" style="margin-top:10px"></div>
    </section>

    <!-- Customer feedback — moved up to sit right after Recent orders /
         dashboard cards so the team sees customer sentiment alongside
         the day-to-day order/profit numbers. Submissions come from the
         floating Feedback button on the home page. -->
    <section class="card" style="margin-top:18px">
      <div class="card-head-row">
        <h2>Customer feedback <span class="muted small" id="adminFeedbackCount"></span></h2>
      </div>
      <div id="adminFeedbackAverages" style="margin-bottom:12px"></div>
      <div id="adminFeedbackList">Loading…</div>
    </section>

    <section class="card" style="margin-top:18px">
      <div class="card-head-row">
        <h2>Customers <span class="muted small" id="adminUsersCount"></span></h2>
        <span class="muted small" id="adminUsersLive"></span>
      </div>
      <div id="adminUsers">Loading…</div>
    </section>

    <section class="card" style="margin-top:18px">
      <div class="card-head-row">
        <h2>Featured products <span class="muted small" id="adminFeaturedCount"></span></h2>
      </div>
      <p class="muted small" style="margin:0 0 8px 0">
        Pasted CJ URLs or SKUs are added to your CJ "My Products" list and pinned to the top of their category pages.
        One per line. URLs and SKUs can be mixed.
      </p>
      <textarea id="adminFeaturedInput" rows="4" placeholder="https://cjdropshipping.com/product/...-p-2604240113311612300.html&#10;CJYD2435107&#10;CJYD286686310JQ" style="width:100%;font-family:monospace;font-size:13px;padding:8px;border-radius:6px;border:1px solid #ddd"></textarea>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button id="adminFeaturedAddBtn" class="btn btn-primary" type="button">Add to Featured</button>
        <!-- The product list is no longer fetched + rendered on every
             admin page load — only when the admin clicks Show. Saves a
             CJ API roundtrip on every visit and keeps the dashboard
             snappy. -->
        <button id="adminFeaturedShowBtn" class="btn btn-ghost" type="button">Show featured products</button>
        <span id="adminFeaturedStatus" class="muted small"></span>
      </div>
      <div id="adminFeatured" style="margin-top:14px" hidden></div>
    </section>
  `;

  try {
    const stats = await adminFetch('/api/admin/dashboard');
    // Signup mix — Google vs email-only — plus a "new this week"
    // sub-label so you can spot acceleration after launching Google
    // Sign-In. Percentages help visualise adoption without pulling
    // up a separate chart.
    const totalU = stats.totalUsers || 0;
    const googleU = stats.googleUsers || 0;
    const emailU = stats.emailOnlyUsers || 0;
    const googlePct = totalU > 0 ? Math.round((googleU / totalU) * 100) : 0;
    const emailPct = totalU > 0 ? Math.round((emailU / totalU) * 100) : 0;
    document.getElementById('adminStats').innerHTML = `
      <div class="stat-card"><div class="stat-label">Orders</div><div class="stat-value">${stats.totalOrders}</div></div>
      <div class="stat-card"><div class="stat-label">Revenue</div><div class="stat-value">${fmtINR(stats.totalRevenue)}</div></div>
      <div class="stat-card"><div class="stat-label">CJ cost</div><div class="stat-value">${fmtINR(stats.totalCost)}</div></div>
      <div class="stat-card stat-profit"><div class="stat-label">Profit</div><div class="stat-value">${fmtINR(stats.totalProfit)}</div><div class="stat-label">${esc(stats.profitMargin)} margin</div></div>
      <div class="stat-card"><div class="stat-label">Total customers</div><div class="stat-value">${totalU.toLocaleString('en-IN')}</div><div class="stat-label">${stats.signups7d || 0} new this week</div></div>
      <div class="stat-card"><div class="stat-label">Google sign-in</div><div class="stat-value">${googleU.toLocaleString('en-IN')} <span class="muted small">· ${googlePct}%</span></div><div class="stat-label">${stats.googleSignups7d || 0} new this week</div></div>
      <div class="stat-card"><div class="stat-label">Email / password</div><div class="stat-value">${emailU.toLocaleString('en-IN')} <span class="muted small">· ${emailPct}%</span></div><div class="stat-label">remaining ${100 - googlePct}% of customers</div></div>
    `;
  } catch (err) {
    if (err.message === 'Unauthorized') return renderAdminLogin();
    document.getElementById('adminStats').innerHTML = `<p class="muted">Failed to load: ${esc(err.message)}</p>`;
  }

  try {
    const data = await adminFetch('/api/admin/orders?page=1&pageSize=10');
    const list = data.orders || [];
    document.getElementById('adminOrders').innerHTML = list.length ? `
      <table class="admin-table">
        <thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Revenue</th><th>Profit</th><th></th></tr></thead>
        <tbody>
          ${list.map(o => `
            <tr>
              <td><code>${esc(o.id)}</code><div class="muted small">${new Date(o.createdAt).toLocaleDateString('en-IN')}</div></td>
              <td>${esc(o.customer?.name || '')}<div class="muted small">${esc(o.customer?.phone || '')}</div></td>
              <td><span class="status-chip status-${esc((o.status || '').toLowerCase())}">${esc(o.status)}</span></td>
              <td>${fmtINR(o.productTotal)}</td>
              <td><strong>${fmtINR(o.profit)}</strong></td>
              <td><a class="btn-sm btn-ghost" href="/order/${encodeURIComponent(o.id)}">View</a></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    ` : '<p class="muted">No orders yet.</p>';
  } catch (err) {
    document.getElementById('adminOrders').innerHTML = `<p class="muted">Failed to load: ${esc(err.message)}</p>`;
  }

  try {
    const p = await adminFetch('/api/admin/pricing');
    const overrides = p.overrides || {};
    const overrideCount = Object.keys(overrides).length;
    document.getElementById('adminPricing').innerHTML = `
      <div class="admin-pricing-row">
        <label>Global markup
          <div class="markup-row">
            <input type="number" id="markupInput" value="${parseInt(p.globalMarkup)}" min="0" max="500" />
            <span>%</span>
            <button class="btn btn-primary btn-sm" onclick="adminSaveMarkup()">Save</button>
          </div>
        </label>
      </div>
      <div class="muted small">${overrideCount} per-product override${overrideCount === 1 ? '' : 's'}</div>
    `;
  } catch (err) {
    document.getElementById('adminPricing').innerHTML = `<p class="muted">Failed to load: ${esc(err.message)}</p>`;
  }

  try {
    const b = await adminFetch('/api/admin/balance');
    const bal = b.data?.amount ?? b.data?.balance ?? '—';
    document.getElementById('adminBalance').innerHTML = `
      <div class="stat-value">$${esc(bal)}</div>
      <p class="muted small">CJ wallet balance (USD). Top up at <a target="_blank" href="https://cjdropshipping.com">cjdropshipping.com</a>.</p>
    `;
  } catch (err) {
    document.getElementById('adminBalance').innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }

  // Catalog & Shipping ops tile. Boots the first load — the buttons
  // themselves use inline onclick (window.adminStartCatalogSync etc)
  // so they always wire up regardless of DOM-ready timing.
  console.log('[Catalog] tile ready (v8.45) — calling loadAdminCatalogStatus');
  loadAdminCatalogStatus();

  // Customers panel — registered users with order rollup. Live-session
  // dot tells admin who's currently signed in.
  try {
    const u = await adminFetch('/api/admin/users');
    const users = u.users || [];
    const countEl = document.getElementById('adminUsersCount');
    const liveEl = document.getElementById('adminUsersLive');
    if (countEl) countEl.textContent = `(${users.length})`;
    if (liveEl) liveEl.textContent = `${u.activeSessions || 0} signed in right now`;
    document.getElementById('adminUsers').innerHTML = users.length ? `
      <table class="admin-table admin-users-table">
        <thead>
          <tr>
            <th></th><th>Name</th><th>Email</th><th>Phone</th>
            <th>Joined</th><th>Orders</th><th>Lifetime</th><th>Last order</th>
          </tr>
        </thead>
        <tbody>
          ${users.map(usr => `
            <tr>
              <td>
                <span class="user-dot user-dot-${usr.sessionLive ? 'live' : 'off'}"
                      title="${usr.sessionLive ? 'Signed in now' : 'Not signed in'}"></span>
              </td>
              <td>
                <strong>${esc(usr.name || '—')}</strong>
                <div class="muted small"><code>${esc(usr.id)}</code></div>
              </td>
              <td>
                <a href="mailto:${esc(usr.email)}">${esc(usr.email)}</a>
              </td>
              <td>${esc(usr.phone || '—')}</td>
              <td>${usr.createdAt ? new Date(usr.createdAt).toLocaleDateString('en-IN') : '—'}</td>
              <td><strong>${usr.orderCount}</strong></td>
              <td>${fmtINR(usr.totalRevenue || 0)}</td>
              <td>${usr.lastOrderAt ? new Date(usr.lastOrderAt).toLocaleDateString('en-IN') : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    ` : '<p class="muted">No customers have signed up yet.</p>';
  } catch (err) {
    document.getElementById('adminUsers').innerHTML = `<p class="muted">Failed to load: ${esc(err.message)}</p>`;
  }

  // Customer feedback card — list submissions + aggregate ratings
  await loadAdminFeedback();

  // Featured Products card — bulk-add textarea is always available, but
  // the product list itself only loads when the admin clicks Show.
  // Saves a CJ API roundtrip on every dashboard visit.
  const showBtn = document.getElementById('adminFeaturedShowBtn');
  const featuredEl = document.getElementById('adminFeatured');
  showBtn?.addEventListener('click', async () => {
    if (!featuredEl) return;
    if (!featuredEl.hidden) {
      // Toggle: hide if currently shown
      featuredEl.hidden = true;
      showBtn.textContent = 'Show featured products';
      return;
    }
    featuredEl.hidden = false;
    featuredEl.innerHTML = 'Loading…';
    showBtn.textContent = 'Hide featured products';
    await loadAdminFeatured();
  });

  document.getElementById('adminFeaturedAddBtn')?.addEventListener('click', async () => {
    const ta = document.getElementById('adminFeaturedInput');
    const statusEl = document.getElementById('adminFeaturedStatus');
    const text = (ta?.value || '').trim();
    if (!text) { statusEl.textContent = 'Paste at least one URL or SKU first.'; return; }
    statusEl.textContent = 'Adding…';
    try {
      const r = await adminPost('/api/admin/my-products/bulk-add', { text });
      const { summary } = r;
      statusEl.textContent = `Added ${summary.added}, already in list ${summary.already}, skipped ${summary.skipped}, errors ${summary.errors}.`;
      if (summary.added || summary.already) ta.value = '';
      // Refresh the displayed list only if it's currently visible
      if (featuredEl && !featuredEl.hidden) {
        setTimeout(loadAdminFeatured, 4000); // CJ propagation lag
      }
    } catch (e) {
      statusEl.textContent = `Failed: ${e.message}`;
    }
  });
}

async function loadAdminFeedback() {
  const list = document.getElementById('adminFeedbackList');
  const averagesEl = document.getElementById('adminFeedbackAverages');
  const countEl = document.getElementById('adminFeedbackCount');
  if (!list) return;

  try {
    const data = await adminFetch('/api/admin/feedback?page=1&pageSize=50');
    const items = data.items || [];
    if (countEl) countEl.textContent = `(${data.total || 0})`;

    // Aggregate averages row — short labels for the dashboard tiles.
    const labels = {
      lookFeel:         'Look & feel',
      variety:          'Product variety',
      easeNav:          'Ease of nav.',
      willUseAgain:     'Surfs in free time',
      willRecommend:    'Will recommend',
      willBuy:          'Likely to buy',
      // Round 2 — market-validation questions
      globalUsEu:       'Interest: US/EU goods',
      trendyTech:       'Interest: trendy tech',
      moneyBackTrust:   '100% money-back trust',
      inclusivePricing: 'All-inclusive pricing',
      delivery15Day:    '15-day delivery × 2M+ catalog',
    };
    if (averagesEl) {
      averagesEl.innerHTML = data.total
        ? `
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
            ${Object.entries(labels).map(([k, lab]) => `
              <div class="stat-card" style="padding:10px 12px">
                <div class="stat-label" style="font-size:11px">${lab}</div>
                <div class="stat-value" style="font-size:18px">${data.averages[k] || '—'}</div>
                <div class="stat-label" style="font-size:10px">avg / 5</div>
              </div>
            `).join('')}
          </div>
        `
        : '<p class="muted small">No feedback yet — share the home page so customers can leave a review.</p>';
    }

    if (!items.length) {
      list.innerHTML = '';
      return;
    }

    // Age-bracket distribution panel — small breakdown above the
    // raw table so the operator can read demographic mix at a glance.
    if (averagesEl && data.ageDistribution) {
      const ageLabels = {
        'under18': 'Under 18',
        '18-24': '18-24',
        '25-34': '25-34',
        '35-44': '35-44',
        '45-54': '45-54',
        '55plus': '55+',
        'unanswered': 'Not stated',
      };
      const ageHtml = `
        <div style="margin-top:12px">
          <div class="muted small" style="margin-bottom:6px">Age distribution</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${Object.entries(ageLabels).map(([k, lab]) => {
              const n = data.ageDistribution[k] || 0;
              return `<span class="stat-card" style="padding:5px 10px;font-size:12px"><strong>${n}</strong> · ${lab}</span>`;
            }).join('')}
          </div>
        </div>
      `;
      averagesEl.insertAdjacentHTML('beforeend', ageHtml);
    }

    list.innerHTML = `
      <table class="admin-table">
        <thead><tr>
          <th>When</th>
          <th>Customer</th>
          <th title="Age bracket">Age</th>
          <th title="Look & feel">Look</th>
          <th title="Product variety">Variety</th>
          <th title="Ease of navigation">Nav</th>
          <th title="Surfs in free time">Surfs</th>
          <th title="Will recommend">Recomm</th>
          <th title="Likely to buy">Buy</th>
          <th title="Interest in US/EU goods">US/EU</th>
          <th title="Interest in trendy tech">Tech</th>
          <th title="100% money-back trust uplift">Refund</th>
          <th title="All-inclusive pricing usefulness">Pricing</th>
          <th title="Likelihood to buy with 15-day delivery + 2M catalog">15-day</th>
          <th>Comments</th>
        </tr></thead>
        <tbody>
          ${items.map(e => {
            // Prefer the contact email the customer typed in the form;
            // fall back to their signed-in account email; else anonymous.
            const customerEmail = e.contactEmail || (e.user && e.user.email) || '';
            const customerName = e.user && e.user.name ? e.user.name : (customerEmail ? '' : 'anonymous');
            // Pretty age label — server stores keys like "18-24"
            // but unanswered is empty string; show "—" for that.
            const AGE_LABELS = {
              'under18': '<18',
              '18-24': '18-24',
              '25-34': '25-34',
              '35-44': '35-44',
              '45-54': '45-54',
              '55plus': '55+',
            };
            const ageLabel = AGE_LABELS[e.ageBracket] || '—';
            return `
            <tr>
              <td class="muted small">${new Date(e.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</td>
              <td>
                ${customerName ? esc(customerName) : ''}${customerName && customerEmail ? '<br>' : ''}${customerEmail ? `<a href="mailto:${esc(customerEmail)}" class="muted small">${esc(customerEmail)}</a>` : (customerName ? '' : '<span class="muted small">anonymous</span>')}
              </td>
              <td class="small">${ageLabel}</td>
              <td>${e.lookFeel || '—'}</td>
              <td>${e.variety || '—'}</td>
              <td>${e.easeNav || '—'}</td>
              <td>${e.willUseAgain || '—'}</td>
              <td>${e.willRecommend || '—'}</td>
              <td>${e.willBuy || '—'}</td>
              <td>${e.globalUsEu || '—'}</td>
              <td>${e.trendyTech || '—'}</td>
              <td>${e.moneyBackTrust || '—'}</td>
              <td>${e.inclusivePricing || '—'}</td>
              <td>${e.delivery15Day || '—'}</td>
              <td style="max-width:280px;white-space:normal">${e.comments ? esc(e.comments) : '<span class="muted small">—</span>'}</td>
            </tr>
          `;
          }).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    list.innerHTML = `<p class="muted">Failed to load feedback: ${esc(err.message)}</p>`;
  }
}

async function loadAdminFeatured() {
  const grid = document.getElementById('adminFeatured');
  if (!grid) return;
  try {
    const data = await adminFetch('/api/admin/my-products');
    const products = data.products || [];
    document.getElementById('adminFeaturedCount').textContent = `(${products.length})`;
    if (!products.length) {
      grid.innerHTML = '<p class="muted">Nothing in Featured yet — paste a URL or SKU above.</p>';
      return;
    }
    grid.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>Image</th><th>Name</th><th>SKU</th><th>PID</th></tr></thead>
        <tbody>
          ${products.map(p => `
            <tr>
              <td><img src="${esc(p.productImage || '')}" alt="" style="width:40px;height:40px;object-fit:cover;border-radius:4px"></td>
              <td>${esc((p.productNameEn || '').slice(0, 80))}</td>
              <td><code>${esc(p.productSku || '')}</code></td>
              <td><code class="muted small">${esc(p.pid || '')}</code></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    grid.innerHTML = `<p class="muted">Failed to load: ${esc(err.message)}</p>`;
  }
}

function renderAdminLogin() {
  app.innerHTML = `
    <div class="login-box">
      <h1>Admin sign in</h1>
      <p class="muted">Enter the admin password to view the dashboard.</p>
      <form id="adminLoginForm">
        <input type="password" id="adminPw" placeholder="Admin password" autofocus required />
        <button class="btn btn-primary" type="submit">Sign in</button>
      </form>
    </div>
  `;
  document.getElementById('adminLoginForm').onsubmit = async (e) => {
    e.preventDefault();
    const pw = document.getElementById('adminPw').value;
    setAdminPw(pw);
    try {
      await adminFetch('/api/admin/dashboard');
      renderAdmin();
    } catch {
      clearAdminPw();
      showToast('Wrong password');
    }
  };
}

window.adminLogout = function() { clearAdminPw(); renderAdminLogin(); };
window.adminSaveMarkup = async function() {
  const v = parseFloat(document.getElementById('markupInput').value);
  if (!isFinite(v) || v < 0) return showToast('Invalid markup');
  try {
    await adminPost('/api/admin/pricing', { globalMarkup: v });
    showToast(`✅ Global markup set to ${v}%`);
  } catch (err) { showToast('Failed: ' + err.message); }
};
// Catalog ops — exposed globally so the tile's inline onclick handlers
// resolve regardless of script load order or DOM-ready edge cases.
window.loadAdminCatalogStatus = loadAdminCatalogStatus;
window.adminStartCatalogSync = adminStartCatalogSync;
window.adminStopCatalogSync  = adminStopCatalogSync;

// ══════════════════════════════════════════════════════════════
//  AUTH — login / register / account / logout
// ══════════════════════════════════════════════════════════════

// Current user is fetched on boot via /api/auth/me. The session cookie is
// httpOnly so the browser sends it automatically; no localStorage token.
function refreshMobilePushTokenRegistration() {
  if (!window.__GLOBAL_SHOPPER_PUSH_TOKEN__ || typeof window.registerMobilePushToken !== 'function') return;
  window.registerMobilePushToken({
    token: window.__GLOBAL_SHOPPER_PUSH_TOKEN__,
    platform: 'android',
    force: true
  });
}

async function loadCurrentUser() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      state.user = data.user || null;
    } else {
      state.user = null;
    }
  } catch { state.user = null; }
  updateAuthSlot();
  if (state.user) refreshMobilePushTokenRegistration();
  // Once we know who's signed in, pull their server-side cart and
  // wishlist down. Cart and wishlist are account-only, so signed-out
  // visitors never keep a guest cart/wishlist on this device.
  if (state.user) {
    if (typeof window.syncCartFromServer === 'function')     window.syncCartFromServer();
    if (typeof window.syncWishlistFromServer === 'function') window.syncWishlistFromServer();
  } else {
    if (typeof window.clearGuestCartStorage === 'function')     window.clearGuestCartStorage();
    if (typeof window.clearGuestWishlistStorage === 'function') window.clearGuestWishlistStorage();
  }
}

function updateAuthSlot() {
  const slot = document.getElementById('authSlot');
  if (state.user) {
    const first = (state.user.name || state.user.email || 'You').split(' ')[0];
    // Desktop signed-in: an icon-only avatar (circle with first initial)
    // that toggles the account dropdown. We dropped the "Hi, Name" label
    // and chevron — the avatar alone is a cleaner cue, matches what
    // standard ecommerce sites (Flipkart, Amazon mobile) do, and avoids
    // the redundancy with the Account item in the bottom nav.
    // Mobile hides .auth-slot entirely via CSS.
    if (slot) slot.innerHTML = `
      <button type="button" class="nav-link nav-account nav-account-icon" id="accountTrigger" aria-haspopup="true" aria-expanded="false" aria-label="Hi, ${esc(first)} — open account menu" title="Account menu">
        <span class="nav-avatar">${esc(first.slice(0, 1).toUpperCase())}</span>
      </button>
    `;
    // Populate dropdown header + wire up toggle/sign-out
    const greet = document.getElementById('accountDropdownGreeting');
    const emailEl = document.getElementById('accountDropdownEmail');
    if (greet) greet.textContent = `Hi, ${first}`;
    if (emailEl) emailEl.textContent = state.user.email || '';
    setupAccountDropdown();
  } else {
    if (slot) slot.innerHTML = `
      <a href="/login" class="nav-link nav-signin" data-page="login">Sign in</a>
      <a href="/register" class="nav-link nav-register-btn" data-page="register">Create account</a>
    `;
    // Hide the dropdown if it was open (e.g. user signed out)
    const dd = document.getElementById('accountDropdown');
    if (dd) dd.hidden = true;
  }
  // Drawer body is JS-rendered from renderDrawer() in app.js, so we
  // have to ask it to rebuild whenever auth state changes (login,
  // register, logout, current-user fetch). Otherwise the drawer keeps
  // showing whatever was rendered last time it was opened.
  if (typeof window.renderDrawer === 'function') window.renderDrawer();
}

// Wire up the account dropdown — toggles open on pill click,
// closes on outside-click or Escape, and signs the user out when
// the Sign out button is clicked. Idempotent: safe to call every
// time updateAuthSlot rebuilds the auth pill.
function setupAccountDropdown() {
  const trigger = document.getElementById('accountTrigger');
  const dd = document.getElementById('accountDropdown');
  if (!trigger || !dd) return;

  // Toggle on click
  trigger.onclick = (e) => {
    e.stopPropagation();
    const open = !dd.hidden;
    dd.hidden = open;
    trigger.setAttribute('aria-expanded', open ? 'false' : 'true');
    if (!open) positionAccountDropdown(trigger, dd);
  };

  // Close when user clicks anywhere else
  if (!setupAccountDropdown._docClickAttached) {
    document.addEventListener('click', (e) => {
      const dd2 = document.getElementById('accountDropdown');
      if (!dd2 || dd2.hidden) return;
      if (e.target.closest('#accountDropdown') || e.target.closest('#accountTrigger')) return;
      dd2.hidden = true;
      const t = document.getElementById('accountTrigger');
      t?.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const dd2 = document.getElementById('accountDropdown');
      if (dd2) dd2.hidden = true;
    });
    setupAccountDropdown._docClickAttached = true;
  }

  // Close on any link click inside the dropdown (so navigating
  // doesn't leave the menu visible on top of the new page)
  dd.querySelectorAll('a').forEach(a => {
    a.onclick = () => { dd.hidden = true; };
  });

  // Sign out
  const signOut = document.getElementById('accountDropdownSignOut');
  if (signOut) signOut.onclick = async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch {}
    state.user = null;
    dd.hidden = true;
    updateAuthSlot();
    showToast('Signed out');
    navigate('/');
  };
}

// Position the dropdown right-aligned under the auth pill so it
// doesn't run off the viewport on narrow desktop windows.
function positionAccountDropdown(trigger, dd) {
  const r = trigger.getBoundingClientRect();
  dd.style.top = (r.bottom + 6) + 'px';
  dd.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
}

async function authPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function authPatch(path, body) {
  const res = await fetch(path, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function requestedAuthRedirect(fallback = '/account') {
  const redirect = new URLSearchParams(location.search).get('redirect') || '';
  if (
    redirect.startsWith('/') &&
    !redirect.startsWith('//') &&
    !/^\/(login|register)\b/i.test(redirect)
  ) return redirect;
  return fallback;
}

function authLink(path) {
  const redirect = requestedAuthRedirect('');
  return redirect ? `${path}?redirect=${encodeURIComponent(redirect)}` : path;
}

// ──────────────────────────────────────────────────────────────
//  Google Sign-In — Web (browser) path
//  ──────────────────────────────────────────────────────────────
//  Drops the official Google Identity Services button into the
//  login/register pages and posts the returned ID token to
//  /api/auth/google. Auto-hides when:
//    • GOOGLE_CLIENT_ID env var isn't set on the server
//    • Running inside the Expo WebView (Google blocks GSI in WebViews;
//      a future native bridge will replace this)
// ──────────────────────────────────────────────────────────────
function googleClientId() {
  return (state.config && state.config.googleClientId) || '';
}
function googleSignInAvailable() {
  if (!googleClientId()) return false;
  // Google explicitly blocks the GSI button inside Android WebView
  // (security policy). Hide it in the app — a native bridge ships
  // later. ReactNativeWebView is the Expo WebView's bridge object.
  if (window.ReactNativeWebView) return false;
  return true;
}
function renderGoogleSignInBlock() {
  if (!googleSignInAvailable()) return '';
  return `
    <div class="auth-google-block">
      <div id="googleSignInButton" class="auth-google-button"></div>
      <div class="auth-divider"><span>or sign in with email</span></div>
    </div>
  `;
}
function mountGoogleSignInButton() {
  if (!googleSignInAvailable()) return;
  const host = document.getElementById('googleSignInButton');
  if (!host) return;
  loadGoogleIdentityScript().then(() => {
    if (!window.google || !window.google.accounts) return;
    try {
      // Decide UX mode at runtime. Safari and some Chrome configurations
      // block third-party popups, which leaves the popup flow staring
      // at a blank accounts.google.com page. The redirect flow works
      // everywhere — Google POSTs the credential to our server, we
      // verify it, set the cookie, and 302 back to the original page.
      // FedCM (Chrome's native API) is used when available — works
      // without third-party cookies.
      // Always use redirect mode — works reliably across Safari,
      // Chrome, Firefox, Edge. Popup mode fights with modern
      // third-party-cookie restrictions and silently fails in Chrome.
      const ux_mode = 'redirect';
      // Stash the current page so the server can redirect us back
      // after the round-trip. Can't put it in login_uri — Google
      // requires login_uri to exactly match a registered redirect
      // URI (no extra query strings).
      try {
        sessionStorage.setItem('gs_google_return', location.pathname || '/account');
      } catch {}
      // ALWAYS use the canonical www host — even if the customer is
      // browsing the apex (`globalshopper.in`). Reason: Render +
      // Cloudflare 301-redirect apex → www, and a 301 strips POST
      // bodies. Google's credential POST to the apex would arrive at
      // www as an empty GET, so verification would fail. By hard-
      // coding www here we send Google's POST straight to the
      // canonical host and avoid the redirect entirely.
      // Only `https://www.globalshopper.in/api/auth/google/callback`
      // needs to be registered in Google Cloud.
      window.google.accounts.id.initialize({
        client_id: googleClientId(),
        callback: onGoogleCredentialResponse,
        auto_select: false,
        cancel_on_tap_outside: true,
        ux_mode,
        login_uri: 'https://www.globalshopper.in/api/auth/google/callback',
        // FedCM was forcing a different OAuth flow on Chrome that has
        // its own redirect-URI requirements unrelated to login_uri,
        // causing redirect_uri_mismatch even when our URI was
        // registered. Disable it — standard redirect flow works in
        // every browser without FedCM.
        use_fedcm_for_prompt: false,
        itp_support: true,
      });
      window.google.accounts.id.renderButton(host, {
        theme: 'outline',
        size: 'large',
        type: 'standard',
        shape: 'pill',
        text: 'continue_with',
        logo_alignment: 'left',
        width: Math.min(360, host.parentElement?.clientWidth || 320),
      });
    } catch (err) {
      console.warn('[google sign-in] init failed:', err.message);
      host.style.display = 'none';
    }
  }).catch(err => {
    console.warn('[google sign-in] script load failed:', err.message);
    host.style.display = 'none';
  });
}

// On page load, surface any error returned from the redirect callback
// so the customer knows why their Google sign-in didn't work.
function showGoogleRedirectErrorIfAny() {
  try {
    const params = new URLSearchParams(location.search);
    const err = params.get('google_error');
    if (!err) return;
    const messages = {
      '1': 'Google sign-in was cancelled or returned no credential.',
      'lib': 'Google sign-in is misconfigured on our server. Please try again later.',
      'payload': "Google didn't return your email. Please try again.",
      'unverified': 'Please verify your Google account email first.',
      'verify': 'We could not verify your Google identity. Please try again.',
    };
    showToast(messages[err] || 'Google sign-in failed. Please try again.', 5000);
    // Clean the URL so a refresh doesn't re-show the toast.
    const clean = location.pathname;
    history.replaceState(null, '', clean);
  } catch {}
}
window.showGoogleRedirectErrorIfAny = showGoogleRedirectErrorIfAny;
let __gsiScriptPromise = null;
function loadGoogleIdentityScript() {
  if (__gsiScriptPromise) return __gsiScriptPromise;
  __gsiScriptPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.accounts) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = (e) => reject(new Error('Could not load Google Identity script'));
    document.head.appendChild(s);
  });
  return __gsiScriptPromise;
}
async function onGoogleCredentialResponse(response) {
  if (!response || !response.credential) {
    showToast('Google sign-in was cancelled');
    return;
  }
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ idToken: response.credential }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.user) throw new Error(data.error || 'Sign-in failed');
    state.user = data.user;
    if (typeof updateAuthSlot === 'function') updateAuthSlot();
    if (typeof refreshMobilePushTokenRegistration === 'function') refreshMobilePushTokenRegistration();
    if (typeof window.syncCartFromServer === 'function')     await window.syncCartFromServer().catch(() => {});
    if (typeof window.syncWishlistFromServer === 'function') await window.syncWishlistFromServer().catch(() => {});
    showToast(`Welcome, ${(data.user.name || '').split(' ')[0] || 'shopper'}!`);
    navigate(requestedAuthRedirect('/account'));
  } catch (err) {
    showToast('Google sign-in failed: ' + err.message, 5000);
  }
}
// Expose so plain HTML onclick handlers (if any) can reach them.
window.onGoogleCredentialResponse = onGoogleCredentialResponse;

function renderLogin() {
  if (state.user) return navigate(requestedAuthRedirect('/account'));
  const registerHref = authLink('/register');
  app.innerHTML = `
    <div class="auth-page">
      <div class="auth-card">
        <h1>Sign in to Global Shopper</h1>
        <p class="muted">New here? <a href="${registerHref}">Create an account</a></p>
        ${renderGoogleSignInBlock()}
        <form id="loginForm" class="auth-form">
          <label>Email
            <input type="email" name="email" required autocomplete="email" autofocus />
          </label>
          <label>Password
            <input type="password" name="password" required autocomplete="current-password" />
          </label>
          <button class="btn btn-primary btn-lg btn-full" type="submit" id="loginBtn">Sign in</button>
          <div class="auth-error" id="loginError"></div>
        </form>
      </div>
    </div>
  `;
  mountGoogleSignInButton();
  showGoogleRedirectErrorIfAny();
  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    const errEl = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');
    errEl.textContent = '';
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const { user } = await authPost('/api/auth/login', fd);
      state.user = user;
      updateAuthSlot();
      refreshMobilePushTokenRegistration();
      // Pull the account cart/wishlist before returning to the requested page.
      if (typeof window.syncCartFromServer === 'function')     await window.syncCartFromServer();
      if (typeof window.syncWishlistFromServer === 'function') await window.syncWishlistFromServer();
      showToast(`Welcome back, ${user.name.split(' ')[0]}`);
      navigate(requestedAuthRedirect('/account'));
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  };
}

function renderRegister() {
  if (state.user) return navigate(requestedAuthRedirect('/account'));
  const loginHref = authLink('/login');
  app.innerHTML = `
    <div class="auth-page">
      <div class="auth-card">
        <h1>Create your Global Shopper account</h1>
        <p class="muted">Already have one? <a href="${loginHref}">Sign in</a></p>
        ${renderGoogleSignInBlock()}
        <form id="registerForm" class="auth-form">
          <label>Full name
            <input type="text" name="name" required autocomplete="name" autofocus />
          </label>
          <label>Email
            <input type="email" name="email" required autocomplete="email" />
          </label>
          <label>Phone (optional)
            <input type="tel" name="phone" autocomplete="tel" placeholder="+91 9999999999" />
          </label>
          <label>Password
            <input type="password" name="password" required minlength="6" autocomplete="new-password" />
            <span class="muted small">At least 6 characters</span>
          </label>
          <button class="btn btn-primary btn-lg btn-full" type="submit" id="registerBtn">Create account</button>
          <div class="auth-error" id="registerError"></div>
        </form>
      </div>
    </div>
  `;
  mountGoogleSignInButton();
  showGoogleRedirectErrorIfAny();
  document.getElementById('registerForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    const errEl = document.getElementById('registerError');
    const btn = document.getElementById('registerBtn');
    errEl.textContent = '';
    btn.disabled = true; btn.textContent = 'Creating account…';
    try {
      const { user } = await authPost('/api/auth/register', fd);
      state.user = user;
      updateAuthSlot();
      refreshMobilePushTokenRegistration();
      // New account starts with empty server cart/wishlist.
      if (typeof window.syncCartFromServer === 'function')     await window.syncCartFromServer();
      if (typeof window.syncWishlistFromServer === 'function') await window.syncWishlistFromServer();
      showToast(`Welcome, ${user.name.split(' ')[0]}!`);
      navigate(requestedAuthRedirect('/account'));
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false; btn.textContent = 'Create account';
    }
  };
}

async function signOutCurrentUser() {
  try { await authPost('/api/auth/logout', {}); } catch {}
  state.user = null;
  if (typeof window.clearGuestCartStorage === 'function')     window.clearGuestCartStorage();
  if (typeof window.clearGuestWishlistStorage === 'function') window.clearGuestWishlistStorage();
  updateAuthSlot();
  showToast('Signed out');
  navigate('/');
}

// Two-step account-deletion flow. Required for Google Play compliance
// AND a basic safety guard: the customer must type "DELETE" so a
// stray tap can't wipe the account. Body sends { confirm: "DELETE" }
// which the server checks too — double-layered.
async function handleDeleteAccountClick() {
  if (!state.user) return;
  const typed = window.prompt(
    'This will permanently delete your account. Type DELETE in capital letters to confirm.'
  );
  if (typed !== 'DELETE') {
    if (typed != null) showToast('Account NOT deleted — exact word "DELETE" required.');
    return;
  }
  try {
    const res = await fetch('/api/auth/me', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ confirm: 'DELETE' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Could not delete account');
    }
    // Same teardown as sign-out — but DON'T call /api/auth/logout
    // (the session is already gone server-side).
    state.user = null;
    if (typeof window.clearGuestCartStorage === 'function')     window.clearGuestCartStorage();
    if (typeof window.clearGuestWishlistStorage === 'function') window.clearGuestWishlistStorage();
    state.cart = [];
    state.wishlist = [];
    updateAuthSlot();
    showToast('Your account has been deleted.');
    navigate('/');
  } catch (err) {
    showToast('Delete failed: ' + err.message, 6000);
  }
}
window.handleDeleteAccountClick = handleDeleteAccountClick;

// Publicly accessible account-deletion explainer + action page.
// Reached at https://www.globalshopper.in/account/delete — Google
// Play reviewers should be able to find the deletion path WITHOUT
// installing the app, so this URL is intentionally permalinked and
// crawlable.
function renderAccountDelete() {
  const signedIn = !!state.user;
  app.innerHTML = `
    <div class="breadcrumb">
      <a href="/">Home</a> <span>›</span>
      <a href="/account">Account</a> <span>›</span>
      <span class="current">Delete account</span>
    </div>
    <section class="card" style="max-width:680px;margin:0 auto">
      <h1>Delete your Global Shopper account</h1>
      <p class="muted">
        You can permanently delete your account at any time. Here's
        what happens when you do:
      </p>
      <ul style="line-height:1.7;margin:14px 0 18px;padding-left:22px">
        <li><strong>Profile</strong> — name, email, phone, address: removed</li>
        <li><strong>Cart and wishlist</strong>: removed</li>
        <li><strong>Saved login sessions</strong> on all devices: signed out</li>
        <li><strong>Order history</strong>: retained for tax and payment-compliance reasons, but you will no longer be able to sign in to view it</li>
        <li><strong>Notifications</strong>: push tokens removed; no further marketing email</li>
      </ul>
      <p class="muted small">This action cannot be undone.</p>
      ${signedIn ? `
        <p>You are signed in as <strong>${esc(state.user.email)}</strong>.</p>
        <button type="button" class="btn btn-danger" id="deleteAccountBtnPublic">Delete my account permanently</button>
      ` : `
        <p>
          To delete your account, please <a href="/login?redirect=%2Faccount%2Fdelete">sign in</a> first.
          Once signed in, this page will show a confirm button — or you
          can use the <em>Delete account</em> section near the bottom
          of the <a href="/account">My Account</a> page inside the app.
        </p>
      `}
      <hr style="margin:22px 0 14px"/>
      <p class="muted small">
        If you'd rather have us delete your account on your behalf, email
        <a href="mailto:help@globalshopper.in">help@globalshopper.in</a>
        from the email address associated with your account and our team
        will process the request within 7 days.
      </p>
    </section>
  `;
  if (signedIn) {
    document.getElementById('deleteAccountBtnPublic').onclick = handleDeleteAccountClick;
  }
}
window.renderAccountDelete = renderAccountDelete;

function renderGuestAccount() {
  app.innerHTML = `
    <div class="breadcrumb"><a href="/">Home</a> <span>›</span> <span class="current">Account</span></div>
    <section class="account-hub account-guest-hub">
      <div class="account-guest-card">
        <div class="account-avatar account-avatar-guest">G</div>
        <h1>Welcome to Global Shopper</h1>
        <p class="muted">Sign in to track orders, save your wishlist, manage returns and keep your cart synced across devices.</p>
        <div class="account-guest-actions">
          <a class="btn btn-primary btn-lg" href="/login">Sign in</a>
          <a class="btn btn-ghost btn-lg" href="/register">Create account</a>
        </div>
      </div>
      <div class="account-action-grid">
        <a href="/login" class="account-action-card"><span>My profile</span><small>Sign in required</small></a>
        <a href="/login" class="account-action-card"><span>My orders</span><small>Track purchases</small></a>
        <a href="/login" class="account-action-card"><span>Returns &amp; refunds</span><small>Request support</small></a>
        <a href="/login?redirect=%2Fwishlist" class="account-action-card"><span>Wishlist</span><small>Sign in required</small></a>
      </div>
    </section>
  `;
}

async function renderAccount() {
  if (!state.user) return renderGuestAccount();

  app.innerHTML = `
    <!-- Breadcrumb removed — the in-page profile header (avatar + name +
         email) is unambiguous about where the user is, and the trail
         was eating vertical space above the fold on mobile. -->
    <div class="account-layout">
      <aside class="account-side">
        <div class="account-avatar">${esc((state.user.name || 'U').slice(0, 1).toUpperCase())}</div>
        <div class="account-name">${esc(state.user.name)}</div>
        <div class="account-email muted small">${esc(state.user.email)}</div>
        <nav class="account-menu-list" aria-label="Account options">
          <a href="/account" class="account-menu-link active">My profile</a>
          <a href="/orders" class="account-menu-link">My orders</a>
          <a href="/returns" class="account-menu-link">Returns &amp; refunds</a>
          <a href="/wishlist" class="account-menu-link">Wishlist</a>
        </nav>
        <button class="btn btn-ghost btn-full account-signout-btn" id="logoutBtn">Sign out</button>
      </aside>
      <div class="account-main">
        <section class="card">
          <h2>Profile</h2>
          <form id="profileForm" class="checkout-form">
            <div class="form-row">
              <label>Full name<input name="name" required value="${esc(state.user.name || '')}" /></label>
              <label>Phone<input name="phone" type="tel" value="${esc(state.user.phone || '')}" /></label>
            </div>
            <button class="btn btn-primary" type="submit">Save changes</button>
            <span class="muted small" id="profileSaved" style="margin-left:12px"></span>
          </form>
        </section>
        <section class="card">
          <h2>Your orders</h2>
          <div id="myOrders">Loading…</div>
        </section>

        <!-- Account deletion — required by Google Play's account-
             deletion policy. Always rendered on the account page so
             customers can find it without hunting. The actual delete
             happens via DELETE /api/auth/me on the server, gated by
             a typed "DELETE" confirmation. -->
        <section class="card account-danger-card">
          <h2>Delete account</h2>
          <p class="muted small">
            Permanently delete your Global Shopper account. Your profile,
            saved cart and wishlist will be removed and you'll be signed
            out. Past orders are kept for tax and payment compliance but
            you'll no longer be able to sign in to view them. This action
            cannot be undone.
          </p>
          <button type="button" class="btn btn-danger" id="deleteAccountBtn">Delete my account</button>
        </section>
      </div>
    </div>
  `;

  document.getElementById('logoutBtn').onclick = signOutCurrentUser;
  document.getElementById('deleteAccountBtn').onclick = handleDeleteAccountClick;

  document.getElementById('profileForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    const savedEl = document.getElementById('profileSaved');
    try {
      const { user } = await authPatch('/api/auth/me', fd);
      state.user = user;
      updateAuthSlot();
      // savedEl could be null if the user navigated away mid-save —
      // belt-and-braces null check so the success/failure write
      // doesn't throw and bubble up to the route's error boundary.
      if (savedEl) savedEl.textContent = '✓ Saved';
      setTimeout(() => {
        const live = document.getElementById('profileSaved');
        if (live) live.textContent = '';
      }, 2500);
    } catch (err) {
      if (savedEl) savedEl.textContent = '✗ ' + err.message;
    }
  };

  // Order history — async fetch. Capture the current route generation
  // so if the user navigates away mid-fetch we bail before touching
  // the DOM (which would throw "Cannot set properties of null").
  const myGen = (typeof currentRouteGen === 'function') ? currentRouteGen() : null;
  try {
    const res = await fetch('/api/auth/orders', { credentials: 'include' });
    const data = await res.json();
    if (typeof isStaleRouteGen === 'function' && isStaleRouteGen(myGen)) return;
    const list = data.orders || [];
    const tbody = list.map(o => `
      <tr>
        <td><code>${esc(o.id)}</code></td>
        <td>${new Date(o.createdAt).toLocaleDateString('en-IN')}</td>
        <td>${o.items.length} item${o.items.length === 1 ? '' : 's'}</td>
        <td><strong>${fmtINR(o.grandTotal)}</strong></td>
        <td><span class="status-chip status-${esc((o.status || '').toLowerCase())}">${esc(o.status)}</span></td>
        <td><a class="btn-sm btn-ghost" href="/order/${encodeURIComponent(o.id)}">View</a></td>
      </tr>
    `).join('');
    safeSetHTML('myOrders', list.length
      ? `<table class="admin-table"><thead><tr><th>Order</th><th>Date</th><th>Items</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>${tbody}</tbody></table>`
      : `<p class="muted">You haven't placed any orders yet. <a href="/">Start shopping</a></p>`);
  } catch (err) {
    if (typeof isStaleRouteGen === 'function' && isStaleRouteGen(myGen)) return;
    safeSetHTML('myOrders', `<p class="muted">Failed to load orders: ${esc(err.message)}</p>`);
  }
}

/* ═══════════════════════════════════════════════════════════════
   Standalone account-related pages reachable from the drawer:
     /orders   → just the orders table from /account, full-width
     /wishlist → account-backed favourites grid
     /returns  → mailto-driven return-request form
   Each gates on auth, redirects to /login if signed out.
   ═══════════════════════════════════════════════════════════════ */

async function renderOrders() {
  if (!state.user) return navigate('/login');
  app.innerHTML = `
    <div class="breadcrumb">
      <a href="/">Home</a> <span>›</span>
      <a href="/account">My account</a> <span>›</span>
      <span class="current">My orders</span>
    </div>
    <h1 class="page-title">My orders</h1>
    <p class="muted">Every order placed under <strong>${esc(state.user.email)}</strong>.</p>
    <section class="card" id="ordersCard"><div id="myOrdersList">Loading…</div></section>
  `;
  const myGen = (typeof currentRouteGen === 'function') ? currentRouteGen() : null;
  try {
    const res = await fetch('/api/auth/orders', { credentials: 'include' });
    const data = await res.json();
    if (typeof isStaleRouteGen === 'function' && isStaleRouteGen(myGen)) return;
    const list = data.orders || [];
    const tbody = list.map(o => `
      <tr>
        <td><code>${esc(o.id)}</code></td>
        <td>${new Date(o.createdAt).toLocaleDateString('en-IN')}</td>
        <td>${o.items.length} item${o.items.length === 1 ? '' : 's'}</td>
        <td><strong>${fmtINR(o.grandTotal)}</strong></td>
        <td><span class="status-chip status-${esc((o.status || '').toLowerCase())}">${esc(o.status)}</span></td>
        <td><a class="btn-sm btn-ghost" href="/order/${encodeURIComponent(o.id)}">View</a></td>
      </tr>
    `).join('');
    safeSetHTML('myOrdersList', list.length
      ? `<table class="admin-table"><thead><tr><th>Order</th><th>Date</th><th>Items</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>${tbody}</tbody></table>`
      : `<p class="muted">No orders yet. <a href="/">Start browsing</a></p>`);
  } catch (err) {
    if (typeof isStaleRouteGen === 'function' && isStaleRouteGen(myGen)) return;
    safeSetHTML('myOrdersList', `<p class="muted">Couldn't load orders: ${esc(err.message)}</p>`);
  }
}

/* Wishlist page — reads state.wishlist (managed in app.js as the
   single source of truth). The persistence + server-sync layer
   lives there too; here we just fetch product details for the saved
   IDs and render. */

async function renderWishlist() {
  if (!state.user) return renderAuthRequiredPage({
    title: 'Sign in to view your wishlist',
    message: 'Your wishlist is saved to your Global Shopper account so hearts stay synced across devices.',
    redirect: '/wishlist'
  });
  const pids = Array.isArray(state.wishlist) ? state.wishlist : [];
  app.innerHTML = `
    <div class="breadcrumb">
      <a href="/">Home</a> <span>›</span>
      <span class="current">Wishlist</span>
    </div>
    <h1 class="page-title">Wishlist</h1>
    <p class="muted">Products you've saved for later. Synced to your account.</p>
    <div class="products-grid" id="wishlistGrid">
      ${pids.length ? Array(pids.length).fill('<div class="product-card skeleton" style="height:280px"></div>').join('') : ''}
    </div>
    ${pids.length ? '' : `
      <div class="empty-state">
        <div class="empty-icon">♡</div>
        <h3>Your wishlist is empty</h3>
        <p class="muted">Tap the heart on any product to save it here.</p>
        <a class="btn btn-primary" href="/">Browse products</a>
      </div>
    `}
  `;
  if (!pids.length) return;
  // Fetch each saved product in parallel and render. Failed lookups
  // (deleted products, blocked items) silently drop from the list.
  const grid = document.getElementById('wishlistGrid');
  const results = await Promise.all(pids.map(async pid => {
    try {
      const r = await fetch(`/api/store/products/${encodeURIComponent(pid)}`);
      if (!r.ok) return null;
      const d = await r.json();
      return d.product || null;
    } catch { return null; }
  }));
  const products = results.filter(Boolean);
  if (!products.length) {
    grid.innerHTML = `<p class="muted">None of your saved products are available right now.</p>`;
    return;
  }
  grid.innerHTML = products.map(p => window.productCard ? window.productCard(p) : '').join('');
}

/* Returns — simple intake form. Every order placed via Razorpay has
   our customer-care email on the receipt; this page formalises the
   request flow without needing a separate ticketing system. */
function renderReturns() {
  if (!state.user) return navigate('/login');
  const c = COMPANY_INFO;
  const supportEmail = c.email || 'sales@befach.com';
  app.innerHTML = `
    <div class="breadcrumb">
      <a href="/">Home</a> <span>›</span>
      <a href="/account">My account</a> <span>›</span>
      <span class="current">Returns &amp; refunds</span>
    </div>
    <h1 class="page-title">Returns &amp; refunds</h1>
    <section class="card">
      <h2>Request a return</h2>
      <p class="muted">If your item arrived damaged, defective, or not as described, we'll process a return or refund within 7 days of delivery. Tell us what happened and we'll be in touch within one business day.</p>
      <form id="returnForm" class="checkout-form" style="margin-top:16px">
        <label>Order ID
          <input name="orderId" required placeholder="ord_..." />
        </label>
        <label>Reason
          <select name="reason" required>
            <option value="">Select a reason</option>
            <option>Arrived damaged</option>
            <option>Wrong item</option>
            <option>Missing parts</option>
            <option>Quality not as described</option>
            <option>Changed my mind</option>
            <option>Other</option>
          </select>
        </label>
        <label>Tell us more
          <textarea name="details" rows="5" placeholder="Photos / order detail / what went wrong" required></textarea>
        </label>
        <button class="btn btn-primary btn-lg" type="submit">Submit request</button>
      </form>
    </section>
    <section class="card" style="margin-top:16px">
      <h2>Need help right now?</h2>
      <p>Email <a href="mailto:${esc(supportEmail)}">${esc(supportEmail)}</a> or <a href="/faq">read the FAQ</a>.</p>
    </section>
  `;
  document.getElementById('returnForm').onsubmit = (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    const subject = `Return request — ${fd.orderId} (${fd.reason})`;
    const body = `Order ID: ${fd.orderId}\nReason: ${fd.reason}\n\n${fd.details}\n\n—\n${state.user.name || ''}\n${state.user.email || ''}`;
    location.href = `mailto:${supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };
}

window.loadCurrentUser = loadCurrentUser;
window.updateAuthSlot = updateAuthSlot;

// Expose pages to app.js's router by name
window.renderCart = renderCart;
window.renderCheckout = renderCheckout;
window.renderOrderDetail = renderOrderDetail;
window.renderTrack = renderTrack;
window.renderAdmin = renderAdmin;
window.renderAbout = renderAbout;
window.renderFaq = renderFaq;
window.renderPrivacy = renderPrivacy;
window.renderLegal = renderLegal;
window.renderLogin = renderLogin;
window.renderRegister = renderRegister;
window.renderOrders = renderOrders;
window.renderWishlist = renderWishlist;
window.renderReturns = renderReturns;
window.renderAccount = renderAccount;

// ══════════════════════════════════════════════════════════════
//  BOOT — runs once both app.js and app-store.js have loaded.
//  Loads config + current user in parallel, then routes.
// ══════════════════════════════════════════════════════════════
(async function boot() {
  try {
    await Promise.all([loadConfig(), loadCurrentUser()]);
  } catch (e) {
    console.warn('boot: config/user load failed', e);
  }
  checkHealth();
  // Was every 30s — bumped to 5 min. The .status-pill is hidden by CSS
  // so frequent polling burns mobile data and floods the console with
  // transient Render-cold-start 502s with no user-visible benefit.
  setInterval(checkHealth, 300000);
  loadCategories();
  handleRoute();
})();
