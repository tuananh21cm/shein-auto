// ==UserScript==
// @name         TikTok Seller - DOM Editor (screenshot helper)
// @namespace    kbt.tools
// @version      1.0
// @description  Thay ten shop + avatar tren DOM de chup man hinh. Ctrl+Shift+X de bat/tat panel.
// @match        https://seller-us.tiktok.com/*
// @match        https://seller.tiktok.com/*
// @match        https://*.tiktok.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const LS_KEY = 'tm_dom_editor_v1';
  const state = Object.assign(
    { newName: '', avatarUrl: '', shopCode: '', email: '', phone: '', autoReapply: true },
    JSON.parse(localStorage.getItem(LS_KEY) || '{}')
  );
  const save = () => localStorage.setItem(LS_KEY, JSON.stringify(state));

  let panel = null;
  let replacing = false; // chan vong lap MutationObserver

  // ---------- thay ten: selector co dinh ----------
  // 3 cho: Seller name (tab new), ten canh avatar header, Shop name (tab old)
  const NAME_SELECTORS = [
    '[data-tid="profile.view.seller_information_new.seller_name"]',
    '[data-tid="profile.view.seller_information_old.shop_name"] [class*="content-"]',
  ];
  // Ten canh avatar header: span dung ke sau m4b_avatar hoac ke sau
  // wrapper cua no (avatar-xxx / trigger-xxx) tuy trang render kieu nao
  function headerNameSpans() {
    const out = [];
    document.querySelectorAll('[data-tid="m4b_avatar"]').forEach((av) => {
      let el = av;
      for (let i = 0; i < 3 && el; i++, el = el.parentElement) {
        const sib = el.nextElementSibling;
        if (sib && sib.tagName === 'SPAN') { out.push(sib); return; }
      }
    });
    return out;
  }
  function replaceName(newName) {
    if (!newName) return 0;
    replacing = true;
    let count = 0;
    const targets = [
      ...document.querySelectorAll(NAME_SELECTORS.join(',')),
      ...headerNameSpans(),
    ];
    for (const el of targets) {
      if (el.textContent === newName) continue;
      el.textContent = newName;
      count++;
    }
    replacing = false;
    return count;
  }

  // ---------- thay 3 field text khac (shop code / email / phone) ----------
  const TEXT_FIELDS = {
    shopCode: '[data-tid="profile.view.seller_information_old.shop_code"]',
    email: '[data-tid="profile.view.seller_information_old.email"]',
    phone: '[data-tid="profile.view.seller_information_old.phone_number"]',
  };
  function replaceField(key, value) {
    if (!value) return 0;
    replacing = true;
    let count = 0;
    document.querySelectorAll(TEXT_FIELDS[key]).forEach((el) => {
      if (el.textContent === value) return;
      el.textContent = value;
      count++;
    });
    replacing = false;
    return count;
  }

  // ---------- random dung format hien thi cua TikTok ----------
  const rint = (n) => Math.floor(Math.random() * n);
  const pick = (s) => s[rint(s.length)];
  function randShopCode() {
    const C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = 'US';
    for (let i = 0; i < 8; i++) s += pick(C);
    return s;
  }
  function randEmail(domain) {
    const L = 'abcdefghijklmnopqrstuvwxyz';
    return pick(L) + '***' + pick(L) + '@' + (domain || 'trillnatives.com');
  }
  function randPhone() {
    let d = '';
    for (let i = 0; i < 4; i++) d += rint(10);
    return '+1****' + d;
  }

  // ---------- observer: tu ap lai khi trang re-render ----------
  let observer = null;
  let debounceTimer = null;
  function startObserver() {
    stopObserver();
    observer = new MutationObserver(() => {
      if (replacing || !state.autoReapply) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (state.newName) replaceName(state.newName);
        if (state.avatarUrl) replaceAvatar(state.avatarUrl);
        if (state.shopCode) replaceField('shopCode', state.shopCode);
        if (state.email) replaceField('email', state.email);
        if (state.phone) replaceField('phone', state.phone);
      }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  // ---------- thay anh: selector co dinh ----------
  // 2 cho: avatar goc phai header + shop logo trong Seller profile
  const AVATAR_SELECTORS = [
    '[data-tid="m4b_avatar"] img',        // avatar header (avatar:logo)
    '[class*="ShopLogoAvatarImg"] img',   // shop logo o Seller profile
  ];
  function replaceAvatar(url) {
    if (!url) return 0;
    let count = 0;
    for (const sel of AVATAR_SELECTORS) {
      document.querySelectorAll(sel).forEach((img) => {
        if (img.src === url) return;
        img.src = url;
        img.removeAttribute('srcset');
        if (img.alt && state.newName) img.alt = state.newName;
        count++;
      });
    }
    return count;
  }

  // ---------- toast nho ----------
  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText =
        'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'background:#111;color:#fff;padding:8px 14px;border-radius:8px;font:13px sans-serif;' +
        'box-shadow:0 4px 12px rgba(0,0,0,.35);pointer-events:none;';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 2500);
  }

  // ---------- panel ----------
  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'tm-dom-editor';
    panel.style.cssText =
      'position:fixed;top:70px;right:16px;z-index:2147483646;width:260px;' +
      'background:#fff;border:1px solid #ddd;border-radius:10px;padding:12px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.18);font:13px sans-serif;color:#222;';
    panel.innerHTML = `
      <div style="font-weight:700;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
        <span>DOM Editor</span>
        <span id="tmde-close" style="cursor:pointer;padding:0 4px">✕</span>
      </div>
      <input id="tmde-new" placeholder="Ten shop moi" style="width:100%;margin-bottom:6px;padding:6px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box">
      <input id="tmde-avatar" placeholder="Link anh avatar/logo moi" style="width:100%;margin-bottom:6px;padding:6px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box">
      <input id="tmde-shopcode" placeholder="Shop code (vd US...)" style="width:100%;margin-bottom:6px;padding:6px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box">
      <input id="tmde-email" placeholder="Email (vd x***x@domain.com)" style="width:100%;margin-bottom:6px;padding:6px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box">
      <input id="tmde-phone" placeholder="Phone (vd +1****1234)" style="width:100%;margin-bottom:6px;padding:6px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box">
      <button id="tmde-random" style="width:100%;margin-bottom:6px;padding:7px;border:0;border-radius:6px;background:#5b5bd6;color:#fff;cursor:pointer">🎲 Random code/email/phone</button>
      <button id="tmde-apply" style="width:100%;margin-bottom:8px;padding:7px;border:0;border-radius:6px;background:#111;color:#fff;cursor:pointer">Thay tat ca</button>
      <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:#555">
        <input type="checkbox" id="tmde-auto"> Tu ap lai khi trang render lai
      </label>
      <div style="margin-top:6px;font-size:11px;color:#999">Ctrl+Shift+X: an/hien panel</div>
    `;
    document.body.appendChild(panel);

    const $ = (id) => panel.querySelector(id);
    $('#tmde-new').value = state.newName;
    $('#tmde-avatar').value = state.avatarUrl;
    $('#tmde-shopcode').value = state.shopCode;
    $('#tmde-email').value = state.email;
    $('#tmde-phone').value = state.phone;
    $('#tmde-auto').checked = state.autoReapply;

    $('#tmde-close').onclick = () => togglePanel(false);
    $('#tmde-auto').onchange = (e) => { state.autoReapply = e.target.checked; save(); };

    $('#tmde-random').onclick = () => {
      // giu domain email cu neu da nhap, khong thi mac dinh
      const curEmail = $('#tmde-email').value.trim();
      const domain = curEmail.includes('@') ? curEmail.split('@')[1] : '';
      $('#tmde-shopcode').value = randShopCode();
      $('#tmde-email').value = randEmail(domain);
      $('#tmde-phone').value = randPhone();
      toast('Da random. Bam "Thay tat ca" de ap.');
    };

    $('#tmde-apply').onclick = () => {
      state.newName = $('#tmde-new').value.trim();
      state.avatarUrl = $('#tmde-avatar').value.trim();
      state.shopCode = $('#tmde-shopcode').value.trim();
      state.email = $('#tmde-email').value.trim();
      state.phone = $('#tmde-phone').value.trim();
      save();
      const nText = replaceName(state.newName)
        + replaceField('shopCode', state.shopCode)
        + replaceField('email', state.email)
        + replaceField('phone', state.phone);
      const nImg = replaceAvatar(state.avatarUrl);
      toast(`Da thay ${nText} cho text, ${nImg} anh.`);
      if (state.autoReapply) startObserver();
    };
  }

  function togglePanel(show) {
    if (!panel) {
      buildPanel();
      panel.style.display = show === false ? 'none' : 'block';
      return;
    }
    const visible = panel.style.display !== 'none';
    const next = show === undefined ? !visible : show;
    panel.style.display = next ? 'block' : 'none';
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyX') {
      e.preventDefault();
      togglePanel();
    }
  });
})();
