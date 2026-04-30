/**
 * Befach Store — Cart, Checkout, Order, Track, Admin, FAQ pages.
 * Loaded after app.js; shares its globals (esc, fmtINR, apiGet, apiPost, state, cart helpers, etc.).
 */

'use strict';

// ══════════════════════════════════════════════════════════════
//  CART PAGE
// ══════════════════════════════════════════════════════════════
function renderCart() {
  const items = state.cart;

  if (!items.length) {
    app.innerHTML = `
      <div class="breadcrumb"><a href="#/">Home</a> <span>›</span> <span class="current">Cart</span></div>
      <div class="empty-state">
        <div class="empty-icon">🛒</div>
        <h3>Your cart is empty</h3>
        <p class="muted">Add some products to get started.</p>
        <a class="btn btn-primary" href="#/">Shop now</a>
      </div>`;
    return;
  }

  app.innerHTML = `
    <div class="breadcrumb"><a href="#/">Home</a> <span>›</span> <span class="current">Cart</span></div>
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
      <a href="#/product/${encodeURIComponent(item.pid)}" class="cart-item-img-wrap">
        <img src="${imgProxy(item.image)}" alt="${esc(item.productName)}" onerror="this.src='/img/befach_logo.png'"/>
      </a>
      <div class="cart-item-info">
        <a class="cart-item-title" href="#/product/${encodeURIComponent(item.pid)}">${esc(item.productName)}</a>
        ${item.variantName ? `<div class="cart-item-variant">${esc(item.variantName)}</div>` : ''}
        <div class="cart-item-price">${fmtINR(item.priceUsd)}</div>
      </div>
      <div class="cart-item-qty">
        <button type="button" class="cart-qty-btn" onclick="cartAdjust('${esc(item.pid)}','${esc(item.vid)}',-1)">−</button>
        <input type="number" min="1" value="${item.quantity}" onchange="cartSetQty('${esc(item.pid)}','${esc(item.vid)}', this.value)"/>
        <button type="button" class="cart-qty-btn" onclick="cartAdjust('${esc(item.pid)}','${esc(item.vid)}',1)">+</button>
      </div>
      <div class="cart-item-line">${fmtINR(parseFloat(item.priceUsd) * item.quantity)}</div>
      <button class="cart-item-remove" title="Remove" onclick="cartRemove('${esc(item.pid)}','${esc(item.vid)}')">✕</button>
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
    <a class="btn btn-ghost btn-full" href="#/">Continue shopping</a>
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
  if (!state.cart.length) return renderCart();

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
      <a href="#/">Home</a> <span>›</span>
      <a href="#/cart">Cart</a> <span>›</span>
      <span class="current">Checkout</span>
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
        <div class="summary-row"><span>Subtotal (${state.cart.length} ${state.cart.length === 1 ? 'item' : 'items'})</span><strong>${fmtINR(cartSubtotalUsd())}</strong></div>
        <div class="summary-row muted"><span>Shipping</span><span>Included</span></div>
        <div class="summary-row muted"><span>Taxes</span><span>Included</span></div>
        <hr/>
        <div class="summary-row summary-total"><span>Total</span><strong id="sumTotal">${fmtINR(cartSubtotalUsd())}</strong></div>
        <button class="btn btn-primary btn-lg btn-full" id="placeOrderBtn">Pay &amp; Place order</button>
        <p class="muted small" style="text-align:center">By placing this order you agree to our terms.</p>
      </aside>
    </div>
  `;

  // Render order summary items
  document.getElementById('checkoutItems').innerHTML = state.cart.map(item => `
    <div class="checkout-item">
      <img src="${imgProxy(item.image)}" alt="" onerror="this.src='/img/befach_logo.png'"/>
      <div class="checkout-item-info">
        <div class="checkout-item-title">${esc(item.productName.slice(0, 50))}${item.productName.length > 50 ? '…' : ''}</div>
        <div class="checkout-item-qty">Qty ${item.quantity}${item.variantName ? ' · ' + esc(item.variantName) : ''}</div>
      </div>
      <div class="checkout-item-price">${fmtINR(parseFloat(item.priceUsd) * item.quantity)}</div>
    </div>
  `).join('');

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

    const itemsPayload = state.cart.map(i => ({ pid: i.pid, vid: i.vid, quantity: i.quantity }));
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

    let intent;
    try {
      intent = await apiPost('/api/store/payment/create-order', { items: itemsPayload });
    } catch (err) {
      showToast('Could not start payment: ' + err.message, 4500);
      btn.disabled = false;
      btn.textContent = 'Pay & Place order';
      return;
    }

    btn.textContent = 'Awaiting payment…';

    const rzp = new Razorpay({
      key: intent.keyId,
      amount: intent.amount,
      currency: intent.currency || 'INR',
      order_id: intent.razorpayOrderId,
      name: 'GCOM',
      description: `${itemsPayload.length} item${itemsPayload.length === 1 ? '' : 's'} from GCOM`,
      // Razorpay shows this image at the top of the checkout modal.
      image: `${location.origin}/img/gcom-logo.png`,
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
            // Save address to user profile (best-effort)
            if (state.user) {
              authPatch('/api/auth/me', {
                phone: fd.phone,
                address: { ...shippingPayload },
              }).catch(() => {});
            }
            clearCart();
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
      <div class="breadcrumb"><a href="#/">Home</a> <span>›</span> <span class="current">Order ${esc(o.id)}</span></div>

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
            <a class="btn btn-ghost btn-full" href="#/track">🔎 Track another order</a>
            <a class="btn btn-primary btn-full" href="#/">Continue shopping</a>
          </div>
        </aside>
      </div>
    `;
  } catch (err) {
    app.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>Order not found</h3><p class="muted">${esc(err.message)}</p><a class="btn btn-primary" href="#/">Home</a></div>`;
  }
}

// ══════════════════════════════════════════════════════════════
//  TRACK PAGE (enter an order ID)
// ══════════════════════════════════════════════════════════════
function renderTrack() {
  app.innerHTML = `
    <div class="breadcrumb"><a href="#/">Home</a> <span>›</span> <span class="current">Track order</span></div>
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
//  LEGAL / COMPANY DETAILS
//  Public page that exposes company registration, GSTIN, IEC, CIN
//  and contact info. Surfaced in the footer; helps establish
//  legitimacy with payment processors and CJ verification.
// ══════════════════════════════════════════════════════════════
function renderLegal() {
  const c = window.COMPANY_INFO || {};
  app.innerHTML = `
    <div class="breadcrumb"><a href="#/">Home</a> <span>›</span> <span class="current">Legal &amp; Compliance</span></div>
    <h1 class="page-title">Legal &amp; Compliance</h1>

    <div class="legal-page">
      <section class="legal-section">
        <h2>About ${esc(c.brandName || 'GCOM')}</h2>
        <p><strong>${esc(c.brandName || 'GCOM')}</strong> is operated by ${esc(c.legalName || 'BEFACH 4X PRIVATE LIMITED')}, a cross-border e-commerce platform that curates premium products from artisans, ateliers, and verified manufacturers in 200+ countries and delivers them to your doorstep in India in 10–15 days. We are an authorised CJ Dropshipping partner (User ID: <strong>${esc(c.cjUserId || '—')}</strong>).</p>
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
        <p>Products listed on this store are sourced from CJ Dropshipping's verified supplier network. Orders placed on ${esc(c.brandName || 'GCOM')} are forwarded to CJ for fulfillment via their official Store Orders API (<code>/shopping/order/createOrderV2</code>). We are responsible for customer service, payments, and warranty handling on the storefront side; CJ handles supplier coordination, packaging and international logistics.</p>
      </section>

      <section class="legal-section">
        <h2>Returns &amp; refunds</h2>
        <p>For shipping times, return windows and refund process, please see our <a href="#/faq">Shipping &amp; FAQ</a>.</p>
      </section>

      <p class="legal-footer-note muted">Last updated: ${new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════
//  FAQ / SHIPPING & RETURNS
// ══════════════════════════════════════════════════════════════
function renderFaq() {
  app.innerHTML = `
    <div class="breadcrumb"><a href="#/">Home</a> <span>›</span> <span class="current">Shipping & FAQ</span></div>
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
        <p>Go to <a href="#/track">Track order</a> and enter the order ID you received after checkout. Tracking updates appear automatically once your package ships.</p>
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

async function renderAdmin() {
  if (!getAdminPw()) return renderAdminLogin();

  app.innerHTML = `
    <div class="breadcrumb"><a href="#/">Home</a> <span>›</span> <span class="current">Admin</span></div>
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
    <section class="card" style="margin-top:18px">
      <div class="card-head-row">
        <h2>Customers <span class="muted small" id="adminUsersCount"></span></h2>
        <span class="muted small" id="adminUsersLive"></span>
      </div>
      <div id="adminUsers">Loading…</div>
    </section>
  `;

  try {
    const stats = await adminFetch('/api/admin/dashboard');
    document.getElementById('adminStats').innerHTML = `
      <div class="stat-card"><div class="stat-label">Orders</div><div class="stat-value">${stats.totalOrders}</div></div>
      <div class="stat-card"><div class="stat-label">Revenue</div><div class="stat-value">${fmtINR(stats.totalRevenue)}</div></div>
      <div class="stat-card"><div class="stat-label">CJ cost</div><div class="stat-value">${fmtINR(stats.totalCost)}</div></div>
      <div class="stat-card stat-profit"><div class="stat-label">Profit</div><div class="stat-value">${fmtINR(stats.totalProfit)}</div><div class="stat-label">${esc(stats.profitMargin)} margin</div></div>
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
              <td><a class="btn-sm btn-ghost" href="#/order/${encodeURIComponent(o.id)}">View</a></td>
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

// ══════════════════════════════════════════════════════════════
//  AUTH — login / register / account / logout
// ══════════════════════════════════════════════════════════════

// Current user is fetched on boot via /api/auth/me. The session cookie is
// httpOnly so the browser sends it automatically; no localStorage token.
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
}

function updateAuthSlot() {
  const slot = document.getElementById('authSlot');
  if (state.user) {
    const first = (state.user.name || state.user.email || 'You').split(' ')[0];
    if (slot) slot.innerHTML = `
      <a href="#/account" class="nav-link nav-account" data-page="account" title="Your account">
        <span class="nav-avatar">${esc(first.slice(0, 1).toUpperCase())}</span>
        <span class="nav-label">Hi, ${esc(first)}</span>
      </a>
    `;
  } else {
    if (slot) slot.innerHTML = `
      <a href="#/login" class="nav-link nav-signin" data-page="login">Sign in</a>
      <a href="#/register" class="nav-link nav-register-btn" data-page="register">Create account</a>
    `;
  }
  // Drawer body is now JS-rendered from renderDrawer() in app.js, so
  // we have to ask it to rebuild whenever auth state changes (login,
  // register, logout, current-user fetch). Otherwise the drawer keeps
  // showing whatever was rendered last open — which is the bug the
  // user reported (still seeing "Sign in" and "Create account" while
  // signed in).
  if (typeof window.renderDrawer === 'function') window.renderDrawer();
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

function renderLogin() {
  if (state.user) return navigate('/account');
  app.innerHTML = `
    <div class="auth-page">
      <div class="auth-card">
        <h1>Sign in to GCOM</h1>
        <p class="muted">New here? <a href="#/register">Create an account</a></p>
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
        <p class="muted small" style="text-align:center">
          Or <a href="#/checkout">continue as guest</a> to checkout without an account
        </p>
      </div>
    </div>
  `;
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
      showToast(`Welcome back, ${user.name.split(' ')[0]}`);
      navigate('/account');
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  };
}

function renderRegister() {
  if (state.user) return navigate('/account');
  app.innerHTML = `
    <div class="auth-page">
      <div class="auth-card">
        <h1>Create your GCOM account</h1>
        <p class="muted">Already have one? <a href="#/login">Sign in</a></p>
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
      showToast(`Welcome, ${user.name.split(' ')[0]}!`);
      navigate('/account');
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false; btn.textContent = 'Create account';
    }
  };
}

async function renderAccount() {
  if (!state.user) return navigate('/login');

  app.innerHTML = `
    <div class="breadcrumb"><a href="#/">Home</a> <span>›</span> <span class="current">My Account</span></div>
    <div class="account-layout">
      <aside class="account-side">
        <div class="account-avatar">${esc((state.user.name || 'U').slice(0, 1).toUpperCase())}</div>
        <div class="account-name">${esc(state.user.name)}</div>
        <div class="account-email muted small">${esc(state.user.email)}</div>
        <button class="btn btn-ghost btn-full" id="logoutBtn">Sign out</button>
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
      </div>
    </div>
  `;

  document.getElementById('logoutBtn').onclick = async () => {
    try { await authPost('/api/auth/logout', {}); } catch {}
    state.user = null;
    updateAuthSlot();
    showToast('Signed out');
    navigate('/');
  };

  document.getElementById('profileForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    const savedEl = document.getElementById('profileSaved');
    try {
      const { user } = await authPatch('/api/auth/me', fd);
      state.user = user;
      updateAuthSlot();
      savedEl.textContent = '✓ Saved';
      setTimeout(() => savedEl.textContent = '', 2500);
    } catch (err) {
      savedEl.textContent = '✗ ' + err.message;
    }
  };

  // Order history
  try {
    const res = await fetch('/api/auth/orders', { credentials: 'include' });
    const data = await res.json();
    const list = data.orders || [];
    const el = document.getElementById('myOrders');
    if (!list.length) {
      el.innerHTML = `<p class="muted">You haven't placed any orders yet. <a href="#/">Start shopping</a></p>`;
    } else {
      el.innerHTML = `
        <table class="admin-table">
          <thead><tr><th>Order</th><th>Date</th><th>Items</th><th>Total</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${list.map(o => `
              <tr>
                <td><code>${esc(o.id)}</code></td>
                <td>${new Date(o.createdAt).toLocaleDateString('en-IN')}</td>
                <td>${o.items.length} item${o.items.length === 1 ? '' : 's'}</td>
                <td><strong>${fmtINR(o.grandTotal)}</strong></td>
                <td><span class="status-chip status-${esc((o.status || '').toLowerCase())}">${esc(o.status)}</span></td>
                <td><a class="btn-sm btn-ghost" href="#/order/${encodeURIComponent(o.id)}">View</a></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }
  } catch (err) {
    document.getElementById('myOrders').innerHTML = `<p class="muted">Failed to load orders: ${esc(err.message)}</p>`;
  }
}

/* ═══════════════════════════════════════════════════════════════
   Standalone account-related pages reachable from the drawer:
     /orders   → just the orders table from /account, full-width
     /wishlist → localStorage-backed favourites grid
     /returns  → mailto-driven return-request form
   Each gates on auth, redirects to /login if signed out.
   ═══════════════════════════════════════════════════════════════ */

async function renderOrders() {
  if (!state.user) return navigate('/login');
  app.innerHTML = `
    <div class="breadcrumb">
      <a href="#/">Home</a> <span>›</span>
      <a href="#/account">My account</a> <span>›</span>
      <span class="current">My orders</span>
    </div>
    <h1 class="page-title">My orders</h1>
    <p class="muted">Every order placed under <strong>${esc(state.user.email)}</strong>.</p>
    <section class="card" id="ordersCard"><div id="myOrdersList">Loading…</div></section>
  `;
  try {
    const res = await fetch('/api/auth/orders', { credentials: 'include' });
    const data = await res.json();
    const list = data.orders || [];
    const el = document.getElementById('myOrdersList');
    if (!list.length) {
      el.innerHTML = `<p class="muted">No orders yet. <a href="#/">Start browsing</a></p>`;
      return;
    }
    el.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>Order</th><th>Date</th><th>Items</th><th>Total</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${list.map(o => `
            <tr>
              <td><code>${esc(o.id)}</code></td>
              <td>${new Date(o.createdAt).toLocaleDateString('en-IN')}</td>
              <td>${o.items.length} item${o.items.length === 1 ? '' : 's'}</td>
              <td><strong>${fmtINR(o.grandTotal)}</strong></td>
              <td><span class="status-chip status-${esc((o.status || '').toLowerCase())}">${esc(o.status)}</span></td>
              <td><a class="btn-sm btn-ghost" href="#/order/${encodeURIComponent(o.id)}">View</a></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    document.getElementById('myOrdersList').innerHTML = `<p class="muted">Couldn't load orders: ${esc(err.message)}</p>`;
  }
}

/* Wishlist — purely client-side, persists to localStorage. Lets users
   ❤ products without needing the server-side feature built out. The
   product detail page reads/writes the same key, so adds/removes
   roundtrip without a backend call. */
const WISHLIST_KEY = 'gcom_wishlist_v1';
function loadWishlist() {
  try { return JSON.parse(localStorage.getItem(WISHLIST_KEY) || '[]'); } catch { return []; }
}
function saveWishlist(pids) {
  try { localStorage.setItem(WISHLIST_KEY, JSON.stringify(pids)); } catch {}
}
window.loadWishlist = loadWishlist;
window.saveWishlist = saveWishlist;

async function renderWishlist() {
  const pids = loadWishlist();
  app.innerHTML = `
    <div class="breadcrumb">
      <a href="#/">Home</a> <span>›</span>
      <span class="current">Wishlist</span>
    </div>
    <h1 class="page-title">Wishlist</h1>
    <p class="muted">Products you've saved for later. Stored on this device.</p>
    <div class="products-grid" id="wishlistGrid">
      ${pids.length ? Array(pids.length).fill('<div class="product-card skeleton" style="height:280px"></div>').join('') : ''}
    </div>
    ${pids.length ? '' : `
      <div class="empty-state">
        <div class="empty-icon">♡</div>
        <h3>Your wishlist is empty</h3>
        <p class="muted">Tap the heart on any product to save it here.</p>
        <a class="btn btn-primary" href="#/">Browse products</a>
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
      <a href="#/">Home</a> <span>›</span>
      <a href="#/account">My account</a> <span>›</span>
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
      <p>Email <a href="mailto:${esc(supportEmail)}">${esc(supportEmail)}</a> or <a href="#/faq">read the FAQ</a>.</p>
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
window.renderFaq = renderFaq;
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
  setInterval(checkHealth, 30000);
  loadCategories();
  handleRoute();
})();
