/* ===== Tomide Williams Partners — shared app runtime (multi-product) ===== */
(function () {
  var PAGE = document.body.getAttribute('data-page') || 'home';

  function esc(t) {
    if (t == null) return '';
    var d = document.createElement('div');
    d.textContent = String(t);
    return d.innerHTML;
  }
  function fmt(k) { return Math.round((k || 0) / 100).toLocaleString(); }
  function naira(k) { return '₦' + fmt(k); }
  function fmtDate(s) {
    if (!s) return '-';
    try { return new Date(s).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (e) { return '-'; }
  }
  function getPartner() {
    try { return JSON.parse(localStorage.getItem('partners_partner')); }
    catch (e) { return null; }
  }
  function getToken() {
    return localStorage.getItem('partners_token') || '';
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
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
      }).catch(fallback);
    } else {
      var ta = document.createElement('textarea');
      ta.value = link; document.body.appendChild(ta); ta.select();
      try {
        document.execCommand('copy'); btn.textContent = 'Copied!'; btn.classList.add('copied');
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
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
          toggleWithdraw(); snack('Withdrawal requested. We\'ll pay you shortly.');
          setTimeout(function () { window.location.reload(); }, 900);
        } else {
          if (d.error === 'Unauthorized. Please log in.') { logout(); return; }
          errEl.textContent = d.error || 'Something went wrong.';
        }
      })
      .catch(function () {
        btnEl.disabled = false; btnEl.textContent = 'Confirm';
        errEl.textContent = 'Network error. Please try again.';
      });
  }

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
    return fetch(qs, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body || undefined,
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.error === 'Unauthorized. Please log in.') { logout(); }
      return d;
    });
  }

  function selectProduct(productId, action) {
    return api('select', { method: 'POST', body: JSON.stringify({ product_id: productId, action: action || 'add' }) });
  }

  // ---- inject sidebar ----
  if (document.getElementById('main') || document.querySelector('.main')) {
    var nav = [
      { key: 'dashboard', label: 'Dashboard', href: '/affiliates/dashboard', ico: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h5v-6h4v6h5V9.5"/>' },
      { key: 'marketplace', label: 'Products', href: '/affiliates/marketplace', ico: '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>' },
      { key: 'myproducts', label: 'My Products', href: '/affiliates/my-products', ico: '<path d="M4 6h16M4 12h16M4 18h10"/><path d="M19 15l1 1-3 3-1.5-1"/>' },
      { key: 'funds', label: 'Earnings', href: '/affiliates/funds', ico: '<rect x="2.5" y="6" width="19" height="13" rx="2.5"/><circle cx="12" cy="12.5" r="3"/><path d="M5.5 9.5h.01M18.5 9.5h.01"/>' },
      { key: 'profile', label: 'Profile', href: '/affiliates/profile', ico: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>' },
    ];

    var brandName = 'Partners';
    var brandSub = 'Tomide Williams';

    var sidebar = document.createElement('aside');
    sidebar.className = 'sidebar';
    var navHtml = '';
    nav.forEach(function (n) {
      var active = n.key === PAGE ? ' active' : '';
      navHtml += '<a class="' + active.trim() + '" href="' + n.href + '"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + n.ico + '</svg>' + esc(n.label) + '</a>';
    });

    var partner = getPartner();
    sidebar.innerHTML =
      '<div class="brand">' +
        '<svg class="mark" width="34" height="34" viewBox="0 0 100 100" fill="none">' +
          '<circle cx="50" cy="50" r="46" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>' +
          '<path d="M 25 35 L 75 35" stroke="#7A0A15" stroke-width="7" stroke-linecap="square"/>' +
          '<path d="M 50 35 L 50 75" stroke="#7A0A15" stroke-width="7" stroke-linecap="square"/>' +
          '<path d="M 20 25 L 35 80 L 50 55 L 65 80 L 80 25" stroke="#050505" stroke-width="12" stroke-linejoin="bevel"/>' +
          '<path d="M 20 25 L 35 80 L 50 55 L 65 80 L 80 25" stroke="#ffffff" stroke-width="4" stroke-linejoin="bevel"/>' +
        '</svg>' +
        '<div class="bb"><div class="brand-name">' + brandName + '</div><div class="brand-sub">' + brandSub + '</div></div>' +
      '</div>' +
      '<nav class="nav">' + navHtml + '</nav>' +
      '<div class="foot">' +
        '<div class="who"><div class="n">' + esc(partner && partner.name || 'Partner') + '</div><div class="e">' + esc(partner && partner.email) + '</div></div>' +
        '<a href="javascript:void(0)" onclick="App.logout()"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 12H5M9 16l-4-4 4-4"/><path d="M19 4h-4v16h4z"/></svg>Logout</a>' +
      '</div>';

    var main = document.querySelector('.main') || document.getElementById('main');
    if (main) {
      var shell = document.createElement('div');
      shell.className = 'app';
      main.parentNode.insertBefore(shell, main);
      shell.appendChild(sidebar);
      var inner = document.createElement('div');
      inner.className = 'content';
      main.parentNode.insertBefore(inner, main);
      inner.appendChild(main);
    }
  }

  window.App = {
    esc, fmt, naira, fmtDate, snack, copyLink, shareWhatsApp,
    logout, getPartner, getToken, toggleWithdraw, submitWithdrawal,
    api, selectProduct,
  };
})();
