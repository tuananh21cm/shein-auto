// ==UserScript==
// @name         SHEIN Scraper v27 - Direct API + SSE + Background
// @namespace    http://tampermonkey.net/
// @version      27.0.0
// @description  Cào SHEIN → POST thẳng lên shein-auto worker. Sync profile từ server. Realtime SSE. Detect out-of-stock per (color × size). Background tab vẫn cào nhờ silent audio.
// @author       shein-auto
// @match        *://*.shein.com/*
// @match        *://*.shein.co.uk/*
// @match        *://*.shein.de/*
// @match        *://*.shein.fr/*
// @match        *://*.shein.it/*
// @match        *://*.shein.es/*
// @connect      localhost
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    /* ====================== CONFIG ====================== */
    const SERVER = GM_getValue('serverUrl', 'http://localhost:3000');
    let API_TOKEN = GM_getValue('apiToken', '');
    let SHOPS = [];   // sync từ server
    // Shop selection persistence (per browser) — mặc định rỗng, user tự pick
    let SELECTED_SHOPS = new Set(
        (() => {
            try { return JSON.parse(GM_getValue('selectedShops', '[]')); }
            catch { return []; }
        })()
    );
    const saveSelectedShops = () => GM_setValue('selectedShops', JSON.stringify([...SELECTED_SHOPS]));

    const SELECTORS = {
        colorSwatches: '.main-sales-attr__color-container .radio-container, .radio-container[role="radio"], [class*="color-radio"]',
        colorNameLabel: '.color-block .sub-title, [class*="color-block"] .sub-title',
        price: '#productMainPriceId, .productPrice__main, [class*="product-intro__head-mainprice"]',
        productName: '.product-intro__head-name .fsp-element, h1.product-intro__head-name',
        mainFeaturedImage: '.product-intro__main-img img, .main-img-container img, .fsp-element.crop-image-container__img',
        sizeButtons: '.product-intro__size-choose [class*="inner"], .size-list [class*="size-item"], .product-intro__size-radio p',
        sizeRadios: '.product-intro__size-radio, .product-intro__size-choose',
        category: '.bread-crumb__inner',
        allProductImages: 'li img.fsp-element, .product-intro__main-img img, .main-img-container img',
        attrTrigger: '.common-entry__container:nth-child(1) .title, .product-intro__description-title',
        attrNames: '.product-intro__attr-list-textname',
        attrValues: '.product-intro__attr-list-textval',
        sizeGuideBtn: '.product-intro__size-guide, [class*="size-guide"], .size-guide-tag, [class*="size-chart"], .product-intro__size-guide-new',
    };

    /* ====================== UTILS ====================== */
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    const getOriginalImageUrl = (url) => {
        if (!url) return null;
        return url.replace(/_thumbnail_\d+x\d+/g, '').replace(/^\/\//, 'https://');
    };

    const getProductIdFromUrl = () => {
        const m = window.location.href.match(/-p-(\d+)\.html/);
        return m ? m[1] : null;
    };

    /**
     * Chuẩn hoá size SHEIN sang dạng TikTok US chấp nhận:
     *   "2 (XS)"   → "XS"
     *   "8/10 (L)" → "L"
     *   "Curve"    → "Curve"  (giữ nguyên nếu không có dạng "(...)")
     *   "One Size" → "One Size"
     */
    const normalizeShein = (raw) => {
        if (!raw) return raw;
        const m = raw.trim().match(/\(([^)]+)\)\s*$/);
        return m ? m[1].trim() : raw.trim();
    };

    /**
     * Bỏ HEADER nhóm fit: tên fit đứng trơ (vd "Regular") HOẶC dạng "<Fit> Size/Sizes"
     * (vd "Regular Sizes", "Plus Size"). GIỮ size thật dù bắt đầu bằng tên fit —
     * vd "Petite XXS" (sau "Petite" còn "XXS", không phải "size(s)") vẫn được lấy.
     * Không phân biệt hoa thường.
     */
    const SKIP_SIZE_RE = /^(regular|tall|curve|plus|petite|pettie|maternity)(\s+sizes?)?$/i;
    const isSkippedSize = (text) => SKIP_SIZE_RE.test((text || '').trim());

    const detectMarket = () => {
        const h = window.location.hostname;
        if (h.endsWith('.co.uk')) return 'UK';
        if (h.endsWith('.de')) return 'DE';
        if (h.endsWith('.fr')) return 'FR';
        if (h.endsWith('.it')) return 'IT';
        if (h.endsWith('.es')) return 'ES';
        return 'US';
    };

    async function forceClick(el) {
        if (!el) return;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await wait(300);
        el.click();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }

    /**
     * Đợi 1 selector có nội dung text khác giá trị cũ (vd: tên màu, giá đổi).
     * Hiệu quả hơn fixed setTimeout — trả về sớm khi DOM đã cập nhật.
     */
    async function waitForChange(selector, prevText, timeoutMs = 2500) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const el = document.querySelector(selector);
            const text = el?.innerText?.trim() ?? '';
            if (text && text !== prevText) return text;
            await wait(150);
        }
        return null;
    }

    /* ============= Background tab keep-alive ============= */
    // Chrome throttle setTimeout/setInterval xuống 1Hz khi tab background.
    // Trick: phát silent audio loop → tab được coi là "playing media" → không throttle.
    let _audioCtx = null;
    function keepAliveStart() {
        if (_audioCtx) return;
        try {
            _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = _audioCtx.createOscillator();
            const gain = _audioCtx.createGain();
            gain.gain.value = 0; // silent
            osc.connect(gain);
            gain.connect(_audioCtx.destination);
            osc.frequency.value = 1; // 1Hz vô cùng thấp
            osc.start();
        } catch (e) {
            console.warn('[SHEIN-SCRAPER] keepAlive audio failed:', e);
        }
    }

    /* ============= GM HTTP wrapper (CORS-free) ============= */
    /**
     * Cross-origin request từ shein.com → localhost.
     * Dùng GM_xmlhttpRequest để bypass CORS (tampermonkey có quyền @connect localhost).
     */
    function gmRequest({ url, method = 'GET', body = null, headers = {} }) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                url,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer ' + API_TOKEN,
                    ...headers,
                },
                data: body ? JSON.stringify(body) : null,
                onload: (resp) => {
                    let json;
                    try { json = JSON.parse(resp.responseText); } catch { json = { raw: resp.responseText }; }
                    if (resp.status >= 200 && resp.status < 300) resolve(json);
                    else reject(new Error(json?.error || `HTTP ${resp.status}`));
                },
                onerror: (e) => reject(new Error('Network error: ' + (e?.error || JSON.stringify(e)))),
                ontimeout: () => reject(new Error('Timeout')),
                timeout: 15000,
            });
        });
    }

    /* ============= API client ============= */
    async function apiSyncProfiles() {
        const data = await gmRequest({ url: `${SERVER}/admin/api/ingest/profiles` });
        SHOPS = data.profiles || [];
        return data;
    }
    async function apiCheck(productId, shops) {
        return gmRequest({
            url: `${SERVER}/admin/api/ingest/check`,
            method: 'POST',
            body: { productId, shops },
        });
    }
    async function apiIngest(data, shops) {
        return gmRequest({
            url: `${SERVER}/admin/api/ingest`,
            method: 'POST',
            body: { data, shops },
        });
    }

    /* ============= SSE: nghe job từ worker ============= */
    function connectSSE() {
        // EventSource không thể custom header → dùng query token
        // Nhưng EventSource bị block bởi CORS từ shein.com → fallback dùng GM_xmlhttpRequest chunked
        // Đơn giản hóa: dùng polling nhẹ 10s cho status workers (đỡ phức tạp hơn streaming)
        const POLL_INTERVAL = 10000;
        const poll = async () => {
            if (!API_TOKEN) return;
            try {
                // Reuse profiles endpoint là rẻ — chỉ check session còn alive
                // (Sẽ thay bằng /status endpoint riêng nếu cần stats chi tiết)
                await apiSyncProfiles();
                document.getElementById('tm-sse-dot').style.background = '#10b981';
                document.getElementById('tm-sse-status').innerText = `🟢 Connected (${SHOPS.length} shops)`;
            } catch (e) {
                document.getElementById('tm-sse-dot').style.background = '#ef4444';
                document.getElementById('tm-sse-status').innerText = `🔴 ${e.message}`;
            }
        };
        poll();
        setInterval(poll, POLL_INTERVAL);
    }

    /* ============= OOS / SIZE MATRIX DETECTION ============= */
    /**
     * Sau khi click 1 màu xong, đọc các size button hiện tại + xác định sizes
     * available (button không bị disabled / sold-out). Bỏ qua nếu chưa load xong.
     */
    function getAvailableSizesForCurrentColor() {
        const buttons = Array.from(document.querySelectorAll(SELECTORS.sizeButtons));
        const available = [];
        const sold = [];
        for (const btn of buttons) {
            const rawText = btn.textContent?.trim();
            if (!rawText) continue;
            if (isSkippedSize(rawText)) continue;  // skip Regular/Tall/Curve/Plus/Petite/Maternity
            const text = normalizeShein(rawText);  // "2 (XS)" → "XS"
            const cls = btn.className || '';
            const parentCls = btn.parentElement?.className || '';
            const isDisabled =
                /disabled|sold-out|sold_out|out-of-stock|not-available|gray/i.test(cls + ' ' + parentCls) ||
                btn.hasAttribute('disabled') ||
                btn.getAttribute('aria-disabled') === 'true';
            if (isDisabled) sold.push(text);
            else available.push(text);
        }
        return { available, sold };
    }

    /* ====================== CORE SCRAPE ====================== */
    async function scrapeProduct() {
        const status = document.getElementById('tm-status-text');
        const overlay = document.getElementById('tm-overlay');
        const overlayMsg = document.getElementById('tm-status-main');

        if (!API_TOKEN) { alert('Chưa có API token! Click ⚙ để thiết lập.'); return; }
        const selectedShops = Array.from(document.querySelectorAll('.tm-acc-checkbox:checked')).map((cb) => cb.value);
        if (selectedShops.length === 0) { alert('Chọn ít nhất 1 shop!'); return; }
        const isDivide4 = document.getElementById('tm-divide-4').checked;

        const productId = getProductIdFromUrl();
        overlay.style.display = 'flex';
        overlayMsg.innerText = 'CHECK DUPLICATE...';

        try {
            // 1. CHECK DEDUP TRƯỚC KHI CÀO
            if (productId) {
                try {
                    const check = await apiCheck(productId, selectedShops);
                    if (check.existsIn?.length > 0) {
                        const dup = check.existsIn;
                        const remaining = selectedShops.filter((s) => !dup.includes(s));
                        if (remaining.length === 0) {
                            if (!confirm(`Sản phẩm này đã có trong TẤT CẢ shops đã chọn (${dup.join(', ')}). Vẫn cào tiếp?`)) {
                                overlay.style.display = 'none';
                                return;
                            }
                        } else {
                            if (!confirm(`⚠️ ${dup.length} shop đã có sản phẩm này:\n${dup.join(', ')}\n\nSẽ chỉ cào cho ${remaining.length} shop còn lại:\n${remaining.join(', ')}\n\nTiếp tục?`)) {
                                overlay.style.display = 'none';
                                return;
                            }
                            // Filter checkboxes + sync persistent state
                            document.querySelectorAll('.tm-acc-checkbox').forEach((cb) => {
                                if (dup.includes(cb.value)) {
                                    cb.checked = false;
                                    SELECTED_SHOPS.delete(cb.value);
                                }
                            });
                            saveSelectedShops();
                            selectedShops.splice(0, selectedShops.length, ...remaining);
                        }
                    }
                } catch (e) {
                    console.warn('[SHEIN-SCRAPER] check failed (skip):', e.message);
                }
            }

            // 2. CÀO ATTRIBUTES
            overlayMsg.innerText = 'CÀO ATTRIBUTES...';
            const attrBtn = document.querySelector(SELECTORS.attrTrigger);
            if (attrBtn) { await forceClick(attrBtn); await wait(800); }
            const attributes = {};
            document.querySelectorAll(SELECTORS.attrNames).forEach((n, i) => {
                const val = document.querySelectorAll(SELECTORS.attrValues)[i]?.innerText.trim();
                if (val) attributes[n.innerText.replace(':', '').trim()] = val;
            });

            // 3. ẢNH SẢN PHẨM CHUNG
            const productImages = Array.from(new Set(
                Array.from(document.querySelectorAll(SELECTORS.allProductImages))
                    .map((img) => getOriginalImageUrl(img.src || img.getAttribute('data-src') || img.dataset.src)),
            )).filter(Boolean).slice(0, 8);

            // 4. SIZE union — normalize "2 (XS)" → "XS"
            const initialSizes = Array.from(document.querySelectorAll(SELECTORS.sizeButtons))
                .map((el) => el.textContent.trim())
                .filter((raw) => raw && !isSkippedSize(raw))  // skip Regular/Tall/Curve/Plus/Petite/Maternity
                .map((raw) => normalizeShein(raw))
                .filter(Boolean);
            const allSizesSet = new Set(initialSizes);

            const data = {
                product_name: document.querySelector(SELECTORS.productName)?.innerText.trim(),
                category: document.querySelector(SELECTORS.category)?.innerText.replace(/\s+/g, ' ').trim(),
                sizes_available: initialSizes,
                variant_ids: [],
                variant_images: [],
                variant_price: [],
                listing_variations: { colors: [], sizes: initialSizes },
                available_matrix: {},  // {colorName: [size1, size2, ...]}
                attributes,
                product_images: productImages,
                url: location.href,
                market: detectMarket(),
                scraped_at: new Date().toISOString(),
            };

            // 5. LOOP TỪNG MÀU
            const swatches = document.querySelectorAll(SELECTORS.colorSwatches);
            const colorCounter = {};
            const oosColors = [];

            if (swatches.length > 0) {
                for (let i = 0; i < swatches.length; i++) {
                    const prevName = document.querySelector(SELECTORS.colorNameLabel)?.innerText.trim() ?? '';
                    await forceClick(swatches[i]);

                    // Đợi tên màu đổi (smart wait, max 2.5s)
                    let rawColorName = await waitForChange(SELECTORS.colorNameLabel, prevName, 2500);
                    if (!rawColorName) {
                        rawColorName = swatches[i].querySelector('img')?.getAttribute('alt')?.trim() || 'Color' + (i + 1);
                    }

                    // Dedup tên (nếu SHEIN trùng tên màu)
                    let finalColorName = rawColorName;
                    if (!colorCounter[rawColorName]) colorCounter[rawColorName] = 1;
                    else { colorCounter[rawColorName]++; finalColorName = `${rawColorName} ${colorCounter[rawColorName]}`; }

                    // Available sizes cho màu này
                    const { available: availSizes, sold: soldSizes } = getAvailableSizesForCurrentColor();
                    availSizes.forEach((s) => allSizesSet.add(s));
                    soldSizes.forEach((s) => allSizesSet.add(s));

                    if (availSizes.length === 0) {
                        console.warn(`[SHEIN-SCRAPER] Màu "${finalColorName}" hết tất cả size, bỏ qua.`);
                        oosColors.push(finalColorName);
                        continue;
                    }

                    // Variant ID từ URL (cập nhật sau khi click)
                    const currentId = getProductIdFromUrl() || 'Unknown';

                    // Giá
                    let priceText = document.querySelector(SELECTORS.price)?.innerText.trim() || '0';
                    if (isDivide4) {
                        const n = parseFloat(priceText.replace(/[^0-9.]/g, ''));
                        if (!isNaN(n)) priceText = (n / 4).toFixed(2);
                    }

                    // Ảnh variant
                    const variantImages = Array.from(new Set(
                        Array.from(document.querySelectorAll(SELECTORS.allProductImages))
                            .map((img) => getOriginalImageUrl(img.src || img.getAttribute('data-src') || img.dataset.src)),
                    )).filter(Boolean);

                    data.listing_variations.colors.push(finalColorName);
                    data.variant_ids.push({ [finalColorName]: currentId });
                    data.variant_images.push({ [finalColorName]: variantImages });
                    data.variant_price.push({ [finalColorName]: priceText });
                    data.available_matrix[finalColorName] = availSizes;

                    status.innerText = `${i + 1}/${swatches.length} ${finalColorName} (${availSizes.length}s, OOS:${soldSizes.length})`;
                }
            } else {
                // No color swatches — single color
                const colorKey = Object.keys(attributes).find((k) => ['Color', 'Farbe', 'Couleur'].includes(k));
                const fallbackColor = attributes[colorKey] || 'Default';
                const { available: availSizes } = getAvailableSizesForCurrentColor();
                data.listing_variations.colors.push(fallbackColor);
                data.variant_ids.push({ [fallbackColor]: getProductIdFromUrl() ?? 'Unknown' });
                data.variant_images.push({ [fallbackColor]: [...productImages] });
                data.variant_price.push({ [fallbackColor]: document.querySelector(SELECTORS.price)?.innerText.trim() ?? '0' });
                data.available_matrix[fallbackColor] = availSizes.length > 0 ? availSizes : initialSizes;
            }

            // Update sizes union (sau khi đi qua tất cả màu, có thể có size lạ)
            data.listing_variations.sizes = Array.from(allSizesSet);

            // OOS WARNING
            if (oosColors.length > 0) {
                const proceed = confirm(`⚠️ ${oosColors.length} màu HẾT HOÀN TOÀN (đã bỏ): ${oosColors.join(', ')}\n\nVẫn đăng listing với các màu còn lại?`);
                if (!proceed) {
                    overlay.style.display = 'none';
                    return;
                }
            }
            if (data.listing_variations.colors.length === 0) {
                alert('Tất cả màu đều hết hàng. Huỷ.');
                overlay.style.display = 'none';
                return;
            }

            // 6. SIZE CHART
            overlayMsg.innerText = 'CÀO SIZE CHART...';
            const sizeBtn = document.querySelector(SELECTORS.sizeGuideBtn)
                || Array.from(document.querySelectorAll('div, span, p, a, button'))
                    .find((el) => /Size Guide|Größentabelle|Guide des tailles/i.test(el.innerText || el.textContent));
            if (sizeBtn) {
                await forceClick(sizeBtn); await wait(1500);
                const table = document.querySelector('.bsc-common-size-table__content_inner-table, table, [class*="size-table"]');
                if (table) {
                    const headers = Array.from(table.querySelectorAll('thead td, thead th')).map((td) => td.innerText.trim());
                    data.size_chart = {
                        unit: document.querySelector('.bsc-sys-switch__item.is-active')?.innerText.trim() || 'cm',
                        data: Array.from(table.querySelectorAll('tbody tr')).map((row) => {
                            const cells = Array.from(row.querySelectorAll('td'));
                            const obj = {};
                            headers.forEach((h, idx) => { if (h) obj[h] = cells[idx]?.innerText.trim(); });
                            return obj;
                        }),
                    };
                }
                const closeBtn = document.querySelector('.modal-header__close, .she-close-external, .f-close');
                if (closeBtn) await forceClick(closeBtn);
            }

            // 7. POST API
            overlayMsg.innerText = `ĐANG GỬI VỀ SERVER (${selectedShops.length} shop)...`;
            const result = await apiIngest(data, selectedShops);
            status.innerText = `✓ Queued ${result.queued?.length} shop · ID ${productId}`;
            overlayMsg.innerText = 'XONG!';
            setTimeout(() => { overlay.style.display = 'none'; }, 1500);
        } catch (e) {
            console.error('[SHEIN-SCRAPER]', e);
            overlayMsg.innerText = '❌ LỖI: ' + e.message;
            status.innerText = 'FAIL: ' + e.message;
            setTimeout(() => { overlay.style.display = 'none'; }, 3500);
        }
    }

    /* ====================== UI ====================== */
    GM_addStyle(`
        #tm-panel{position:fixed;bottom:10px;right:10px;z-index:999999;background:#fff;border:2px solid #ae122a;padding:12px;border-radius:10px;font-family:sans-serif;width:300px;box-shadow:0 6px 20px rgba(0,0,0,0.25);}
        #tm-panel .head{font-weight:bold;color:#ae122a;text-align:center;border-bottom:1px solid #eee;padding-bottom:6px;display:flex;justify-content:space-between;align-items:center;}
        #tm-panel .head .settings{cursor:pointer;font-size:18px;}
        .tm-btn-pro{background:#ae122a;color:#fff;border:none;padding:10px;cursor:pointer;font-weight:bold;width:100%;border-radius:6px;margin-top:8px;transition:0.2s;}
        .tm-btn-pro:hover{background:#000;}
        .tm-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:8px;max-height:160px;overflow-y:auto;padding-right:4px;}
        .tm-acc-item{font-size:11px;display:flex;align-items:center;gap:5px;cursor:pointer;padding:3px;border-radius:4px;}
        .tm-acc-item:hover{background:#fff5f5;}
        .tm-sse-bar{display:flex;align-items:center;gap:6px;margin-top:8px;padding:4px 8px;background:#fafafa;border-radius:6px;font-size:11px;color:#666;}
        .tm-sse-bar .dot{width:8px;height:8px;border-radius:50%;background:#9ca3af;}
        #tm-overlay{position:fixed;inset:0;background:rgba(255,255,255,0.92);z-index:999998;display:none;align-items:center;justify-content:center;flex-direction:column;font-weight:bold;color:#ae122a;}
        @keyframes tm-spin{to{transform:rotate(360deg);}}
        .tm-spinner{border:4px solid #f3f3f3;border-top:4px solid #ae122a;border-radius:50%;width:42px;height:42px;animation:tm-spin 1s linear infinite;}
        #tm-modal{position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:999997;display:none;align-items:center;justify-content:center;}
        #tm-modal .box{background:#fff;padding:24px;border-radius:12px;min-width:380px;max-width:90vw;}
        #tm-modal label{display:block;font-size:12px;color:#666;margin:8px 0 4px;}
        #tm-modal input{width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-family:monospace;font-size:12px;box-sizing:border-box;}
        #tm-modal .row{display:flex;gap:8px;margin-top:16px;}
        #tm-modal button{flex:1;padding:10px;border:none;border-radius:6px;cursor:pointer;font-weight:bold;}
    `);

    function initUI() {
        if (document.getElementById('tm-panel')) return;

        const overlay = document.createElement('div');
        overlay.id = 'tm-overlay';
        overlay.innerHTML = `<div class="tm-spinner"></div><p id="tm-status-main" style="margin-top:14px;">PROCESSING...</p>`;
        document.body.appendChild(overlay);

        const modal = document.createElement('div');
        modal.id = 'tm-modal';
        modal.innerHTML = `
            <div class="box">
                <h3 style="margin:0 0 8px;color:#ae122a;">SHEIN Scraper Settings</h3>
                <label>Server URL</label>
                <input id="tm-server-url" value="${SERVER}" placeholder="http://localhost:3000" />
                <label>API Token <span style="color:#999;">(lấy từ Admin UI → Users)</span></label>
                <input id="tm-api-token" value="${API_TOKEN}" placeholder="tm_..." />
                <div class="row">
                    <button id="tm-modal-cancel" style="background:#eee;color:#333;">Cancel</button>
                    <button id="tm-modal-save" style="background:#ae122a;color:#fff;">Lưu</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const panel = document.createElement('div');
        panel.id = 'tm-panel';
        panel.innerHTML = `
            <div class="head">
                <span>SHEIN SCRAPER v27</span>
                <span class="settings" title="Settings">⚙</span>
            </div>
            <label class="tm-acc-item" style="background:#fff5f5;padding:5px;border:1px dashed #ae122a;border-radius:4px;">
                <input type="checkbox" id="tm-divide-4"> Price divider (/4)
            </label>
            <div id="tm-shops" class="tm-grid"></div>
            <button class="tm-btn-pro" id="tm-start">📤 SCRAPE & UPLOAD</button>
            <div class="tm-sse-bar"><span id="tm-sse-dot" class="dot"></span><span id="tm-sse-status">Connecting...</span></div>
            <div id="tm-status-text" style="font-size:10px;color:#666;text-align:center;margin-top:6px;font-style:italic;min-height:14px;">READY</div>
        `;
        document.body.appendChild(panel);

        document.getElementById('tm-start').onclick = scrapeProduct;
        panel.querySelector('.settings').onclick = () => { modal.style.display = 'flex'; };
        document.getElementById('tm-modal-cancel').onclick = () => { modal.style.display = 'none'; };
        document.getElementById('tm-modal-save').onclick = () => {
            const newServer = document.getElementById('tm-server-url').value.trim().replace(/\/$/, '');
            const newToken = document.getElementById('tm-api-token').value.trim();
            GM_setValue('serverUrl', newServer);
            GM_setValue('apiToken', newToken);
            API_TOKEN = newToken;
            modal.style.display = 'none';
            location.reload();
        };

        // Initial: sync shops + start polling
        renderShops();
        if (API_TOKEN) {
            keepAliveStart();
            apiSyncProfiles().then(renderShops).catch(() => {});
            connectSSE();
        } else {
            document.getElementById('tm-sse-status').innerText = '⚙ Mở settings để paste API token';
        }
    }

    function renderShops() {
        const wrap = document.getElementById('tm-shops');
        if (!wrap) return;
        const market = detectMarket();
        if (SHOPS.length === 0) {
            wrap.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#999;font-size:11px;padding:8px;">No shops (set token + restart)</div>';
            return;
        }

        // Cleanup SELECTED_SHOPS — bỏ shop không còn tồn tại trên server
        for (const s of [...SELECTED_SHOPS]) if (!SHOPS.includes(s)) SELECTED_SHOPS.delete(s);

        wrap.innerHTML = SHOPS.map((s) => {
            const matchesMarket = s.includes(`_${market}`) || (market === 'US' && !s.includes('_'));
            const checked = SELECTED_SHOPS.has(s);
            // Mặc định rỗng — không auto-check theo market. User tự pick. Lưu localStorage.
            return `<label class="tm-acc-item" style="${matchesMarket ? '' : 'opacity:0.55;'}" title="${matchesMarket ? '' : 'Khác market hiện tại (vẫn chọn được)'}">
                <input type="checkbox" class="tm-acc-checkbox" value="${s}" ${checked ? 'checked' : ''}>
                ${s}
            </label>`;
        }).join('');

        // Bind: lưu selection mỗi khi tick/untick
        wrap.querySelectorAll('.tm-acc-checkbox').forEach((cb) => {
            cb.onchange = () => {
                if (cb.checked) SELECTED_SHOPS.add(cb.value);
                else SELECTED_SHOPS.delete(cb.value);
                saveSelectedShops();
            };
        });
    }

    GM_registerMenuCommand('⚙ SHEIN Scraper Settings', () => {
        document.getElementById('tm-modal').style.display = 'flex';
    });

    initUI();
    setInterval(initUI, 3000);
})();
