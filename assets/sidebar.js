// Partners Platform — Shared Shell & App Helpers
(function () {
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmt(n) {
    return (n || 0).toLocaleString('en-US');
  }
  function naira(kobo) {
    var n = Math.round((kobo || 0) / 100);
    return '₦' + n.toLocaleString('en-US');
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) { return iso; }
  }

  function getPartner() {
    try { return JSON.parse(localStorage.getItem('partners_partner')); }
    catch (e) { return null; }
  }
  function getToken() {
    try {
      return localStorage.getItem('partners_token') || sessionStorage.getItem('partners_token') || '';
    } catch(e) { return ''; }
  }

  function syncPartnerInfo() {
    var p = getPartner();
    var nameEl = document.getElementById('sbPartnerName');
    var emailEl = document.getElementById('sbPartnerEmail');
    if (nameEl && p) nameEl.textContent = p.name || 'Partner';
    if (emailEl && p) emailEl.textContent = p.email || '';
  }

  function snack(msg) {
    var el = document.getElementById('snackbar');
    if (!el) {
      el = document.createElement('div');
      el.id = 'snackbar';
      el.className = 'snackbar';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  function copyLink(btn, link) {
    function fallback() { snack('Copy failed. Long-press and copy manually.'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(function () {
        btn.textContent = 'Copied!'; btn.classList.add('copied');
        setTimeout(function () { btn.textContent = 'Copy Link'; btn.classList.remove('copied'); }, 2000);
      }).catch(fallback);
    } else {
      var ta = document.createElement('textarea');
      ta.value = link; document.body.appendChild(ta); ta.select();
      try {
        document.execCommand('copy'); btn.textContent = 'Copied!'; btn.classList.add('copied');
        setTimeout(function () { btn.textContent = 'Copy Link'; btn.classList.remove('copied'); }, 2000);
      } catch (e) { fallback(); }
      document.body.removeChild(ta);
    }
  }

  function shareWhatsApp(link, text) {
    var url = 'https://wa.me/?text=' + encodeURIComponent((text || 'Grab this: ') + ' ' + link);
    window.open(url, '_blank');
  }

  function logout() {
    localStorage.removeItem('partners_partner');
    localStorage.removeItem('partners_token');
    sessionStorage.clear();
    window.location.href = '/affiliates/login';
  }

  function toggleWithdraw() {
    var el = document.getElementById('withdrawForm');
    if (!el) return;
    var open = el.classList.toggle('open');
    if (open) {
      var a = document.getElementById('withdrawAmount');
      var e = document.getElementById('withdrawErr');
      if (a) a.value = '';
      if (e) e.textContent = '';
      if (a) a.focus();
    }
  }

  function submitWithdrawal() {
    var token = getToken();
    var amtEl = document.getElementById('withdrawAmount');
    var errEl = document.getElementById('withdrawErr');
    var btnEl = document.getElementById('wfConfirm');
    if (!token) { window.location.href = '/affiliates/login'; return; }
    var amt = parseFloat(amtEl.value);
    if (!amt || amt <= 0) { errEl.textContent = 'Please enter a valid amount.'; return; }
    var kobo = Math.round(amt * 100);
    errEl.textContent = '';
    btnEl.disabled = true;
    btnEl.textContent = 'Submitting...';
    api('withdraw', { method: 'POST', body: JSON.stringify({ amount_kobo: kobo }) })
      .then(function (d) {
        btnEl.disabled = false; btnEl.textContent = 'Confirm';
        if (d.ok) {
          toggleWithdraw(); snack('Withdrawal requested. We will pay you shortly.');
          setTimeout(function () { window.location.href = '/affiliates/funds'; }, 900);
        } else {
          if (d.error === 'Unauthorized. Please log in.') { logout(); return; }
          if (d.need_bank) {
            errEl.textContent = 'Add your bank details to your profile to withdraw.';
            setTimeout(function () { window.location.href = '/affiliates/profile'; }, 1400);
            return;
          }
          errEl.textContent = d.error || 'Something went wrong.';
        }
      })
      .catch(function () {
        btnEl.disabled = false; btnEl.textContent = 'Confirm';
        errEl.textContent = 'Network error. Please try again.';
      });
  }

  // Fast API client with session cache
  window._apiCache = window._apiCache || {};

  function api(action, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    var qs = '/api/partner?action=' + encodeURIComponent(action);
    var params = opts.params || {};
    Object.keys(params).forEach(function (k) {
      if (params[k] != null) qs += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    });

    var cacheKey = action + JSON.stringify(params);

    if (opts.onCache && window._apiCache[cacheKey]) {
      try { opts.onCache(window._apiCache[cacheKey]); } catch(e){}
    }

    return fetch(qs, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body || undefined,
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.error === 'Unauthorized. Please log in.') { logout(); }
      if (opts.method !== 'POST') {
        window._apiCache[cacheKey] = d;
        try { sessionStorage.setItem('cache_' + cacheKey, JSON.stringify(d)); } catch(e){}
      }
      return d;
    }).catch(function(err) {
      return { ok: false, error: 'Network error. Please try again.' };
    });
  }

  function getCached(action, params) {
    var cacheKey = action + JSON.stringify(params || {});
    if (window._apiCache[cacheKey]) return window._apiCache[cacheKey];
    try {
      var raw = sessionStorage.getItem('cache_' + cacheKey);
      if (raw) {
        var parsed = JSON.parse(raw);
        window._apiCache[cacheKey] = parsed;
        return parsed;
      }
    } catch(e){}
    return null;
  }

  function selectProduct(productId, action) {
    return api('select', { method: 'POST', body: JSON.stringify({ product_id: productId, action: action || 'add' }) });
  }

  // Clean Navigation Items
  var navItems = [
    { key: 'dashboard', label: 'Dashboard', href: '/affiliates/dashboard', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h5v-6h4v6h5V9.5"/></svg>' },
    { key: 'marketplace', label: 'Market', href: '/affiliates/marketplace', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/></svg>' },
    { key: 'myproducts', label: 'Products', href: '/affiliates/my-products', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/><path d="M19 15l1 1-3 3-1.5-1"/></svg>' },
    { key: 'leaderboard', label: 'Leaders', href: '/affiliates/leaderboard', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.45 1-1 1H7.5a1.5 1.5 0 0 0-1.5 1.5V22"/><path d="M14 14.66V17c0 .55.45 1 1 1h1.5a1.5 1.5 0 0 1 1.5 1.5V22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>' },
    { key: 'funds', label: 'Earnings', href: '/affiliates/funds', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="13" rx="2.5"/><circle cx="12" cy="12.5" r="3"/><path d="M5.5 9.5h.01M18.5 9.5h.01"/></svg>' },
    { key: 'profile', label: 'Profile', href: '/affiliates/profile', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>' },
  ];

  function injectMobileShell() {
    if (document.querySelector('.mobile-topbar')) return;

    var topBar = document.createElement('div');
    topBar.className = 'mobile-topbar';
    topBar.innerHTML = '<div class="brand">' +
      '<svg width="28" height="28" viewBox="0 0 100 100" fill="none">' +
        '<circle cx="50" cy="50" r="46" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>' +
        '<path d="M 25 35 L 75 35" stroke="#7A0A15" stroke-width="7" stroke-linecap="square"/>' +
        '<path d="M 50 35 L 50 75" stroke="#7A0A15" stroke-width="7" stroke-linecap="square"/>' +
        '<path d="M 20 25 L 35 80 L 50 55 L 65 80 L 80 25" stroke="#050505" stroke-width="12" stroke-linejoin="bevel"/>' +
        '<path d="M 20 25 L 35 80 L 50 55 L 65 80 L 80 25" stroke="#ffffff" stroke-width="4" stroke-linejoin="bevel"/>' +
      '</svg>' +
      '<div><div class="brand-name">Partners</div><div class="brand-sub">Tomide Williams</div></div>' +
    '</div>' +
    '<button class="mobile-logout-btn" onclick="App.logout()">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 12H5M9 16l-4-4 4-4"/><path d="M19 4h-4v16h4z"/></svg>' +
      'Logout' +
    '</button>';

    var bottomNav = document.createElement('nav');
    bottomNav.className = 'mobile-bottom-nav';
    var path = window.location.pathname;
    var bHtml = '';
    navItems.forEach(function(item){
      var active = (path.indexOf(item.href) === 0 || (item.key === 'myproducts' && path.indexOf('/affiliates/product') === 0)) ? ' active' : '';
      bHtml += '<a class="mobile-nav-item' + active + '" href="' + item.href + '">' +
        item.icon +
        '<span>' + item.label + '</span>' +
      '</a>';
    });
    bottomNav.innerHTML = bHtml;

    document.body.insertBefore(topBar, document.body.firstChild);
    document.body.appendChild(bottomNav);
  }

  function init() {
    injectMobileShell();
    syncPartnerInfo();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.App = {
    esc: esc, fmt: fmt, naira: naira, fmtDate: fmtDate, snack: snack, copyLink: copyLink, shareWhatsApp: shareWhatsApp,
    logout: logout, getPartner: getPartner, getToken: getToken, toggleWithdraw: toggleWithdraw, submitWithdrawal: submitWithdrawal,
    api: api, getCached: getCached, selectProduct: selectProduct, syncPartnerInfo: syncPartnerInfo
  };
})();
