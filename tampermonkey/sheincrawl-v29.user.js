// ==UserScript==
// @name         SHEIN Scraper v29 - Direct API + SSE + Background
// @namespace    http://tampermonkey.net/
// @version      29.4.0
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

    // ĐA-ACCOUNT: mỗi user 1 token, dùng SONG SONG. [{ name, token }]
    let ACCOUNTS = (() => {
        try {
            const a = JSON.parse(GM_getValue('accounts', '[]'));
            if (Array.isArray(a) && a.length) return a.filter((x) => x && x.token);
        } catch { /* ignore */ }
        // Migration từ apiToken cũ
        const legacy = GM_getValue('apiToken', '');
        return legacy ? [{ name: 'Default', token: legacy }] : [];
    })();
    const saveAccounts = () => GM_setValue('accounts', JSON.stringify(ACCOUNTS));

    // Runtime: shops theo từng account — [{ name, token, shops:[], error? }]
    let ACCOUNT_SHOPS = [];

    // Selection: Set các key "accIdx::shop" (phân biệt shop trùng tên giữa user)
    let SELECTED = new Set(
        (() => { try { return JSON.parse(GM_getValue('selectedKeys', '[]')); } catch { return []; } })()
    );
    const saveSelected = () => GM_setValue('selectedKeys', JSON.stringify([...SELECTED]));

    // Accordion: Set tên account đang MỞ (rỗng = gập hết — mặc định). Nhớ qua các lần.
    let EXPANDED = new Set(
        (() => { try { return JSON.parse(GM_getValue('expandedAccts', '[]')); } catch { return []; } })()
    );
    const saveExpanded = () => GM_setValue('expandedAccts', JSON.stringify([...EXPANDED]));

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

    /** Bộ ảnh gallery hiện tại (dedup, URL gốc không thumbnail). */
    const getGalleryImages = () => Array.from(new Set(
        Array.from(document.querySelectorAll(SELECTORS.allProductImages))
            .map((img) => getOriginalImageUrl(img.src || img.getAttribute('data-src') || img.dataset.src)),
    )).filter(Boolean);

    const gallerySignature = (imgs) => imgs.slice().sort().join('|');

    /**
     * Đợi gallery đổi ảnh sau khi click swatch màu. SHEIN cập nhật tên màu TRƯỚC,
     * ảnh gallery swap SAU — nếu chỉ đợi tên màu rồi chụp gallery ngay thì màu mới
     * dính nguyên bộ ảnh của màu trước (gốc lỗi ảnh variant lệch tên trên 4Seller).
     * 2 pha: (1) đợi signature khác bộ ảnh trước lúc click, (2) đợi gallery ổn định
     * (không đổi thêm ~450ms) để không chụp lúc đang swap dở. Timeout → trả bộ hiện tại.
     */
    async function waitForGalleryChange(prevSignature, timeoutMs = 5000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (gallerySignature(getGalleryImages()) !== prevSignature) break;
            await wait(150);
        }
        let lastSig = gallerySignature(getGalleryImages());
        let lastChange = Date.now();
        while (Date.now() - lastChange < 450 && Date.now() - start < timeoutMs + 2000) {
            await wait(150);
            const sig = gallerySignature(getGalleryImages());
            if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
        }
        return getGalleryImages();
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
    function gmRequest({ url, method = 'GET', body = null, headers = {}, token = '' }) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                url,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer ' + (token || ''),
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

    /* ============= API client (per-token) ============= */
    async function apiSyncProfiles(token) {
        const data = await gmRequest({ url: `${SERVER}/admin/api/ingest/profiles`, token });
        return data.profiles || [];
    }
    async function apiCheck(productId, shops, token) {
        return gmRequest({
            url: `${SERVER}/admin/api/ingest/check`,
            method: 'POST',
            body: { productId, shops },
            token,
        });
    }
    async function apiIngest(data, shops, token) {
        return gmRequest({
            url: `${SERVER}/admin/api/ingest`,
            method: 'POST',
            body: { data, shops },
            token,
        });
    }
    /** Đẩy 1 sản phẩm vào Hub chung (không cần shop). */
    async function apiHubIngest(data, token) {
        return gmRequest({
            url: `${SERVER}/admin/api/hub/ingest`,
            method: 'POST',
            body: { data },
            token,
        });
    }

    /** Nạp shops cho MỌI account song song → ACCOUNT_SHOPS. Trả về {users, shops, errors}. */
    async function syncAllAccounts() {
        ACCOUNT_SHOPS = await Promise.all(ACCOUNTS.map(async (acc) => {
            try {
                const shops = await apiSyncProfiles(acc.token);
                return { name: acc.name, token: acc.token, shops };
            } catch (e) {
                return { name: acc.name, token: acc.token, shops: [], error: e.message };
            }
        }));
        const shopCount = ACCOUNT_SHOPS.reduce((n, a) => n + a.shops.length, 0);
        const errCount = ACCOUNT_SHOPS.filter((a) => a.error).length;
        return { users: ACCOUNT_SHOPS.length, shops: shopCount, errors: errCount };
    }

    /* ============= SSE: nghe job từ worker ============= */
    function connectSSE() {
        // EventSource không thể custom header → dùng query token
        // Nhưng EventSource bị block bởi CORS từ shein.com → fallback dùng GM_xmlhttpRequest chunked
        // Đơn giản hóa: dùng polling nhẹ 10s cho status workers (đỡ phức tạp hơn streaming)
        const POLL_INTERVAL = 10000;
        const poll = async () => {
            if (ACCOUNTS.length === 0) return;
            try {
                const { users, shops, errors } = await syncAllAccounts();
                renderShops();
                const dot = document.getElementById('tm-sse-dot');
                const st = document.getElementById('tm-sse-status');
                if (errors > 0) {
                    dot.style.background = '#ef4444';
                    st.innerText = `🔴 ${errors}/${users} user lỗi token · ${shops} shops`;
                } else {
                    dot.style.background = '#10b981';
                    st.innerText = `🟢 ${users} user · ${shops} shops`;
                }
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

        if (ACCOUNTS.length === 0) { alert('Chưa có account nào! Click ⚙ để thêm token.'); return; }

        // CHẾ ĐỘ HUB: cào xong đẩy thẳng vào Hub chung (không cần chọn shop).
        const isHubMode = document.getElementById('tm-hub-mode')?.checked;
        const hubToken = (ACCOUNTS[0] && ACCOUNTS[0].token) || '';

        // Gom các shop đã tick thành NHÓM theo account (key = "accIdx::shop")
        const groups = new Map(); // accIdx → { name, token, shops:[] }
        if (!isHubMode) {
            const checkedKeys = Array.from(document.querySelectorAll('.tm-acc-checkbox:checked')).map((cb) => cb.value);
            if (checkedKeys.length === 0) { alert('Chọn ít nhất 1 shop!'); return; }
            for (const key of checkedKeys) {
                const sep = key.indexOf('::');
                const accIdx = Number(key.slice(0, sep));
                const shop = key.slice(sep + 2);
                const acc = ACCOUNT_SHOPS[accIdx];
                if (!acc || !acc.token) continue;
                if (!groups.has(accIdx)) groups.set(accIdx, { name: acc.name, token: acc.token, shops: [] });
                groups.get(accIdx).shops.push(shop);
            }
            if (groups.size === 0) { alert('Không có shop hợp lệ để cào.'); return; }
        }

        const isDivide4 = document.getElementById('tm-divide-4').checked;
        const isSingleColor = document.getElementById('tm-single-color')?.checked;

        const productId = getProductIdFromUrl();
        overlay.style.display = 'flex';
        overlayMsg.innerText = 'CHECK DUPLICATE...';

        try {
            // 1. CHECK DEDUP theo TỪNG account (token riêng)
            if (productId) {
                try {
                    const dupByAcc = await Promise.all([...groups.entries()].map(async ([idx, g]) => {
                        try {
                            const check = await apiCheck(productId, g.shops, g.token);
                            return { idx, dup: check.existsIn || [] };
                        } catch (e) {
                            console.warn(`[SHEIN-SCRAPER] check "${g.name}" lỗi (skip):`, e.message);
                            return { idx, dup: [] };
                        }
                    }));
                    const dupLines = [];
                    let dupTotal = 0, remainTotal = 0;
                    const remainByIdx = new Map();
                    for (const [idx, g] of groups) {
                        const dup = (dupByAcc.find((d) => d.idx === idx) || {}).dup || [];
                        const remaining = g.shops.filter((s) => !dup.includes(s));
                        remainByIdx.set(idx, remaining);
                        if (dup.length) { dupLines.push(`${g.name}: ${dup.join(', ')}`); dupTotal += dup.length; }
                        remainTotal += remaining.length;
                    }
                    if (dupTotal > 0) {
                        const proceedAll = remainTotal === 0;
                        const msg = proceedAll
                            ? `Sản phẩm đã có trong TẤT CẢ shop đã chọn:\n${dupLines.join('\n')}\n\nVẫn cào (đăng trùng)?`
                            : `⚠️ Đã có sản phẩm ở:\n${dupLines.join('\n')}\n\nSẽ chỉ cào ${remainTotal} shop còn lại. Tiếp tục?`;
                        if (!confirm(msg)) { overlay.style.display = 'none'; return; }
                        if (!proceedAll) {
                            for (const [idx, g] of [...groups]) {
                                const remaining = remainByIdx.get(idx);
                                if (remaining.length === 0) groups.delete(idx);
                                else g.shops = remaining;
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[SHEIN-SCRAPER] dedup lỗi (skip):', e.message);
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
            const productImages = getGalleryImages().slice(0, 8);

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
                oos_matrix: {},  // {colorName: [oosSize1, oosSize2, ...]}
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

            if (swatches.length > 0 && !isSingleColor) {
                for (let i = 0; i < swatches.length; i++) {
                    const prevName = document.querySelector(SELECTORS.colorNameLabel)?.innerText.trim() ?? '';
                    const prevGallerySig = gallerySignature(getGalleryImages());
                    await forceClick(swatches[i]);

                    // Đợi tên màu đổi (smart wait, max 2.5s)
                    let rawColorName = await waitForChange(SELECTORS.colorNameLabel, prevName, 2500);
                    const nameChanged = rawColorName !== null;
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
                        console.warn(`[SHEIN-SCRAPER] Màu "${finalColorName}" hết tất cả size → qty sẽ = 0.`);
                        oosColors.push(finalColorName);
                    }

                    // Variant ID từ URL (cập nhật sau khi click)
                    const currentId = getProductIdFromUrl() || 'Unknown';

                    // Giá
                    let priceText = document.querySelector(SELECTORS.price)?.innerText.trim() || '0';
                    if (isDivide4) {
                        const n = parseFloat(priceText.replace(/[^0-9.]/g, ''));
                        if (!isNaN(n)) priceText = (n / 4).toFixed(2);
                    }

                    // Ảnh variant — PHẢI đợi gallery swap xong, không chụp ngay sau khi
                    // tên màu đổi. Tên đổi = chắc chắn màu đã switch → đợi đủ 5s;
                    // tên không đổi (swatch đang được chọn sẵn, thường là màu đầu) →
                    // gallery có thể không đổi, chỉ đợi ngắn 1.5s cho chắc.
                    const variantImages = await waitForGalleryChange(prevGallerySig, nameChanged ? 5000 : 1500);
                    if (nameChanged && gallerySignature(variantImages) === prevGallerySig) {
                        console.warn(`[SHEIN-SCRAPER] ⚠️ Gallery không đổi sau 5s cho màu "${finalColorName}" — ảnh có thể dính màu trước.`);
                    }

                    data.listing_variations.colors.push(finalColorName);
                    data.variant_ids.push({ [finalColorName]: currentId });
                    data.variant_images.push({ [finalColorName]: variantImages });
                    data.variant_price.push({ [finalColorName]: priceText });
                    data.available_matrix[finalColorName] = availSizes;
                    if (soldSizes.length > 0) data.oos_matrix[finalColorName] = soldSizes;

                    status.innerText = `${i + 1}/${swatches.length} ${finalColorName} (${availSizes.length}s, OOS:${soldSizes.length})`;
                }
            } else {
                // CHỈ lấy màu ĐANG HIỂN THỊ — gộp 2 trường hợp:
                //  (a) bật "Chỉ cào màu đang hiển thị" trên sản phẩm nhiều màu, hoặc
                //  (b) sản phẩm vốn 1 màu (không có swatch).
                // KHÔNG click swatch nào → giữ nguyên ảnh/giá/size của màu đang chọn.
                const attrColorKey = Object.keys(attributes).find((k) => ['Color', 'Farbe', 'Couleur'].includes(k));
                const rawColorName =
                    document.querySelector(SELECTORS.colorNameLabel)?.innerText.trim()
                    || document.querySelector(SELECTORS.colorSwatches + ' img')?.getAttribute('alt')?.trim()
                    || (attrColorKey ? attributes[attrColorKey] : '')
                    || 'Default';

                const { available: availSizes, sold: soldSizes } = getAvailableSizesForCurrentColor();
                availSizes.forEach((s) => allSizesSet.add(s));
                soldSizes.forEach((s) => allSizesSet.add(s));

                let priceText = document.querySelector(SELECTORS.price)?.innerText.trim() || '0';
                if (isDivide4) {
                    const n = parseFloat(priceText.replace(/[^0-9.]/g, ''));
                    if (!isNaN(n)) priceText = (n / 4).toFixed(2);
                }

                const variantImages = getGalleryImages();

                data.listing_variations.colors.push(rawColorName);
                data.variant_ids.push({ [rawColorName]: getProductIdFromUrl() ?? 'Unknown' });
                data.variant_images.push({ [rawColorName]: variantImages.length ? variantImages : [...productImages] });
                data.variant_price.push({ [rawColorName]: priceText });
                data.available_matrix[rawColorName] = availSizes.length ? availSizes : initialSizes;
                if (soldSizes.length) data.oos_matrix[rawColorName] = soldSizes;

                if (isSingleColor) console.log(`[SHEIN-SCRAPER] Chế độ 1 màu: chỉ cào "${rawColorName}".`);
            }

            // Update sizes union (sau khi đi qua tất cả màu, có thể có size lạ)
            data.listing_variations.sizes = Array.from(allSizesSet);

            // OOS INFO (giữ tất cả màu, qty = 0 cho OOS)
            if (oosColors.length > 0) {
                console.log(`[SHEIN-SCRAPER] ${oosColors.length} màu OOS 100%: ${oosColors.join(', ')} → qty = 0`);
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
            if (isHubMode) {
                // Đẩy thẳng vào Hub chung (1 lần, dùng token account đầu tiên)
                overlayMsg.innerText = 'ĐANG ĐẨY VÀO HUB...';
                try {
                    await apiHubIngest(data, hubToken);
                    status.innerText = `✓ Đã đẩy vào Hub · ID ${productId}`;
                    overlayMsg.innerText = '🗂️ ĐÃ VÀO HUB!';
                    setTimeout(() => { overlay.style.display = 'none'; }, 1500);
                } catch (e) {
                    console.error('[SHEIN-SCRAPER] hub ingest lỗi:', e.message);
                    status.innerText = 'FAIL Hub: ' + e.message;
                    overlayMsg.innerText = '❌ LỖI HUB: ' + e.message;
                    setTimeout(() => { overlay.style.display = 'none'; }, 3000);
                }
            } else {
                // mỗi account gửi bằng ĐÚNG token của user đó (song song)
                const totalShops = [...groups.values()].reduce((n, g) => n + g.shops.length, 0);
                overlayMsg.innerText = `ĐANG GỬI VỀ SERVER (${groups.size} user · ${totalShops} shop)...`;
                const results = await Promise.all([...groups.values()].map(async (g) => {
                    try {
                        const r = await apiIngest(data, g.shops, g.token);
                        return { name: g.name, queued: (r.queued || []).length, ok: true };
                    } catch (e) {
                        console.error(`[SHEIN-SCRAPER] ingest "${g.name}" lỗi:`, e.message);
                        return { name: g.name, queued: 0, ok: false, error: e.message };
                    }
                }));
                const okCount = results.filter((r) => r.ok).reduce((n, r) => n + r.queued, 0);
                const failed = results.filter((r) => !r.ok);
                status.innerText = failed.length
                    ? `✓ ${okCount} shop · ✗ ${failed.map((f) => f.name).join(',')} · ID ${productId}`
                    : `✓ Queued ${okCount} shop (${groups.size} user) · ID ${productId}`;
                overlayMsg.innerText = failed.length ? `⚠️ Lỗi: ${failed.map((f) => f.name).join(', ')}` : 'XONG!';
                setTimeout(() => { overlay.style.display = 'none'; }, failed.length ? 3000 : 1500);
            }
        } catch (e) {
            console.error('[SHEIN-SCRAPER]', e);
            overlayMsg.innerText = '❌ LỖI: ' + e.message;
            status.innerText = 'FAIL: ' + e.message;
            setTimeout(() => { overlay.style.display = 'none'; }, 3500);
        }
    }

    /* ====================== UI ====================== */
    GM_addStyle(`
        #tm-panel{position:fixed;bottom:10px;right:10px;z-index:999999;background:#fff;border:2px solid #ae122a;padding:12px;border-radius:10px;font-family:sans-serif;width:300px;box-shadow:0 6px 20px rgba(0,0,0,0.25);max-height:92vh;display:flex;flex-direction:column;}
        #tm-panel .head{font-weight:bold;color:#ae122a;text-align:center;border-bottom:1px solid #eee;padding-bottom:6px;display:flex;justify-content:space-between;align-items:center;}
        #tm-panel .head .settings{cursor:pointer;font-size:18px;}
        #tm-panel .head .head-btns{display:flex;align-items:center;gap:8px;}
        #tm-panel .head .minimize{cursor:pointer;font-size:20px;line-height:1;color:#ae122a;padding:0 4px;border-radius:4px;}
        #tm-panel .head .minimize:hover{background:#fff5f5;}
        /* Nút nổi để mở lại panel khi đã ẩn */
        #tm-fab{position:fixed;bottom:10px;right:10px;z-index:999999;width:44px;height:44px;border-radius:50%;background:#ae122a;color:#fff;display:none;align-items:center;justify-content:center;cursor:pointer;font-weight:bold;font-family:sans-serif;font-size:18px;box-shadow:0 4px 14px rgba(0,0,0,0.3);}
        #tm-fab:hover{background:#000;}
        .tm-btn-pro{background:#ae122a;color:#fff;border:none;padding:10px;cursor:pointer;font-weight:bold;width:100%;border-radius:6px;margin-top:8px;transition:0.2s;}
        .tm-btn-pro:hover{background:#000;}
        .tm-grid{margin-top:8px;flex:1 1 auto;min-height:60px;overflow-y:auto;padding-right:4px;}
        #tm-shop-search{width:100%;margin-top:8px;padding:6px 8px;border:1px solid #ddd;border-radius:6px;font-size:12px;box-sizing:border-box;}
        #tm-shop-search:focus{outline:none;border-color:#ae122a;}
        .tm-acc-item{font-size:11px;display:flex;align-items:center;gap:5px;cursor:pointer;padding:3px;border-radius:4px;}
        .tm-acc-item:hover{background:#fff5f5;}
        .tm-acc-group-head{position:sticky;top:0;background:#fff;z-index:2;cursor:pointer;display:flex;align-items:center;gap:6px;padding:5px 2px;border-top:1px solid #eee;font-weight:bold;color:#ae122a;font-size:11px;user-select:none;}
        .tm-acc-group-head:hover{background:#fff5f5;}
        .tm-acc-arrow{display:inline-block;width:10px;text-align:center;font-size:10px;}
        /* Mỗi nhóm shop tự cuộn riêng → header user luôn hiện, không trôi khi cuộn */
        .tm-acc-shops{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px 0;max-height:220px;overflow-y:auto;}
        #tm-selected-summary{margin-top:8px;padding:6px 8px;background:#fff5f5;border:1px solid #f0c9cf;border-radius:6px;font-size:10.5px;color:#555;max-height:96px;overflow-y:auto;line-height:1.5;}
        #tm-selected-summary .tm-sel-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px;}
        #tm-selected-summary .tm-sel-head{font-weight:bold;color:#ae122a;}
        #tm-selected-summary .tm-sel-clear{flex:0 0 auto;background:#fee;color:#c0392b;border:1px solid #e0b4b4;border-radius:5px;padding:2px 8px;cursor:pointer;font-size:10px;font-weight:bold;}
        #tm-selected-summary .tm-sel-clear:hover{background:#c0392b;color:#fff;}
        #tm-selected-summary .tm-sel-shops{word-break:break-word;}
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
                <label>Accounts <span style="color:#999;">(mỗi user 1 token — dùng SONG SONG)</span></label>
                <div id="tm-acc-list" style="max-height:150px;overflow:auto;margin-bottom:6px;"></div>
                <div style="display:flex;gap:6px;">
                    <input id="tm-acc-name" placeholder="Tên (vd dbscan)" style="flex:1;" />
                    <input id="tm-acc-token" placeholder="tm_token..." style="flex:2;" />
                    <button id="tm-acc-add" style="flex:0 0 auto;background:#ae122a;color:#fff;padding:8px 12px;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">Thêm</button>
                </div>
                <div class="row">
                    <button id="tm-modal-cancel" style="background:#eee;color:#333;">Đóng</button>
                    <button id="tm-modal-save" style="background:#ae122a;color:#fff;">Lưu & tải lại</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // ===== Account manager (thêm/xoá token) =====
        const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
        const maskToken = (t) => (t.length > 12 ? t.slice(0, 6) + '…' + t.slice(-4) : t);
        const renderAccList = () => {
            const box = document.getElementById('tm-acc-list');
            if (!ACCOUNTS.length) { box.innerHTML = '<div style="color:#999;font-size:11px;padding:6px;">Chưa có account. Thêm bên dưới.</div>'; return; }
            box.innerHTML = ACCOUNTS.map((a, i) => `
                <div style="display:flex;align-items:center;gap:6px;padding:4px 2px;border-bottom:1px solid #f0f0f0;font-size:12px;">
                    <b style="flex:0 0 auto;">👤 ${esc(a.name)}</b>
                    <span style="flex:1;color:#999;font-family:monospace;">${esc(maskToken(a.token))}</span>
                    <button data-i="${i}" class="tm-acc-del" style="flex:0 0 auto;background:#fee;color:#c0392b;border:1px solid #e0b4b4;border-radius:5px;padding:3px 8px;cursor:pointer;">Xoá</button>
                </div>`).join('');
            box.querySelectorAll('.tm-acc-del').forEach((btn) => {
                btn.onclick = () => { ACCOUNTS.splice(Number(btn.dataset.i), 1); saveAccounts(); renderAccList(); reloadShops(); };
            });
        };
        const reloadShops = () => { syncAllAccounts().then(renderShops).catch(() => {}); };
        renderAccList();
        document.getElementById('tm-acc-add').onclick = () => {
            const name = document.getElementById('tm-acc-name').value.trim();
            const token = document.getElementById('tm-acc-token').value.trim();
            if (!name || !token) { alert('Nhập cả Tên và Token'); return; }
            ACCOUNTS.push({ name, token });
            saveAccounts();
            document.getElementById('tm-acc-name').value = '';
            document.getElementById('tm-acc-token').value = '';
            renderAccList();
            reloadShops();
        };

        const panel = document.createElement('div');
        panel.id = 'tm-panel';
        panel.innerHTML = `
            <div class="head">
                <span>SHEIN SCRAPER v29</span>
                <span class="head-btns">
                    <span class="settings" title="Settings">⚙</span>
                    <span class="minimize" title="Ẩn panel">–</span>
                </span>
            </div>
            <label class="tm-acc-item" style="background:#fff5f5;padding:5px;border:1px dashed #ae122a;border-radius:4px;">
                <input type="checkbox" id="tm-divide-4"> Price divider (/4)
            </label>
            <label class="tm-acc-item" style="background:#fff5f5;padding:5px;border:1px dashed #ae122a;border-radius:4px;">
                <input type="checkbox" id="tm-single-color"> Chỉ cào màu đang hiển thị
            </label>
            <label class="tm-acc-item" id="tm-hub-mode-row" style="background:#eef6ff;padding:5px;border:1px dashed #2563eb;border-radius:4px;color:#1d4ed8;font-weight:bold;">
                <input type="checkbox" id="tm-hub-mode"> 🗂️ Đẩy vào Hub (không cần chọn shop)
            </label>
            <input id="tm-shop-search" placeholder="🔍 Tìm shop..." />
            <div id="tm-shops" class="tm-grid"></div>
            <div id="tm-selected-summary" style="display:none;"></div>
            <button class="tm-btn-pro" id="tm-start">📤 SCRAPE & UPLOAD</button>
            <div class="tm-sse-bar"><span id="tm-sse-dot" class="dot"></span><span id="tm-sse-status">Connecting...</span></div>
            <div id="tm-status-text" style="font-size:10px;color:#666;text-align:center;margin-top:6px;font-style:italic;min-height:14px;">READY</div>
        `;
        document.body.appendChild(panel);

        // Nút nổi để mở lại panel sau khi ẩn
        const fab = document.createElement('div');
        fab.id = 'tm-fab';
        fab.title = 'Mở SHEIN Scraper';
        fab.textContent = 'S';
        document.body.appendChild(fab);

        // Ẩn/hiện panel — nhớ trạng thái qua GM_setValue
        const setPanelHidden = (hidden) => {
            panel.style.display = hidden ? 'none' : '';
            fab.style.display = hidden ? 'flex' : 'none';
            GM_setValue('panelHidden', !!hidden);
        };
        panel.querySelector('.minimize').onclick = () => setPanelHidden(true);
        fab.onclick = () => setPanelHidden(false);
        setPanelHidden(GM_getValue('panelHidden', false));

        document.getElementById('tm-start').onclick = scrapeProduct;
        const shopSearch = document.getElementById('tm-shop-search');
        if (shopSearch) shopSearch.oninput = () => renderShops();
        panel.querySelector('.settings').onclick = () => { modal.style.display = 'flex'; };
        document.getElementById('tm-modal-cancel').onclick = () => { modal.style.display = 'none'; };
        document.getElementById('tm-modal-save').onclick = () => {
            const newServer = document.getElementById('tm-server-url').value.trim().replace(/\/$/, '');
            GM_setValue('serverUrl', newServer);
            modal.style.display = 'none';
            location.reload();
        };

        // Initial: sync shops mọi account + start polling
        renderShops();
        if (ACCOUNTS.length) {
            keepAliveStart();
            reloadShops();
            connectSSE();
        } else {
            document.getElementById('tm-sse-status').innerText = '⚙ Mở settings để thêm token';
        }
    }

    /* renderShops — nhóm shop theo TỪNG account (đa-user song song) */
    function renderShops() {
        const wrap = document.getElementById('tm-shops');
        if (!wrap) return;
        const market = detectMarket();
        const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

        const hasAny = ACCOUNT_SHOPS.some((a) => a.shops.length || a.error);
        if (!hasAny) {
            wrap.innerHTML = '<div style="text-align:center;color:#999;font-size:11px;padding:8px;">Chưa có shop — thêm token trong ⚙</div>';
            return;
        }

        // Cleanup SELECTED: bỏ key mà account/shop không còn
        const valid = new Set();
        ACCOUNT_SHOPS.forEach((a, idx) => a.shops.forEach((s) => valid.add(`${idx}::${s}`)));
        for (const k of [...SELECTED]) if (!valid.has(k)) SELECTED.delete(k);

        // Lọc theo ô tìm shop (áp trên mọi user). Search khác rỗng → auto mở nhóm có kết quả.
        const q = (document.getElementById('tm-shop-search')?.value || '').toLowerCase().trim();

        const blocks = ACCOUNT_SHOPS.map((acc, idx) => {
            const matched = q ? acc.shops.filter((s) => s.toLowerCase().includes(q)) : acc.shops;
            if (q && matched.length === 0) return ''; // ẩn user không có shop khớp
            const open = EXPANDED.has(acc.name) || !!q;
            const header = `<div class="tm-acc-group-head" data-acc="${idx}" data-name="${esc(acc.name)}">
                <span class="tm-acc-arrow">${open ? '▾' : '▸'}</span>
                <input type="checkbox" class="tm-acc-all" data-acc="${idx}">
                <span>👤 ${esc(acc.name)} ${acc.error ? '<span style="color:#ef4444;">(lỗi token)</span>' : `(${matched.length}${q ? '/' + acc.shops.length : ''})`}</span>
            </div>`;
            const shops = matched.map((s) => {
                const key = `${idx}::${s}`;
                const matchesMarket = s.includes(`_${market}`) || (market === 'US' && !s.includes('_'));
                const checked = SELECTED.has(key);
                return `<label class="tm-acc-item" style="${matchesMarket ? '' : 'opacity:0.55;'}" title="${matchesMarket ? '' : 'Khác market hiện tại'}">
                    <input type="checkbox" class="tm-acc-checkbox" data-acc="${idx}" value="${esc(key)}" ${checked ? 'checked' : ''}> ${esc(s)}
                </label>`;
            }).join('');
            return `${header}<div class="tm-acc-shops" data-acc="${idx}" style="display:${open ? 'grid' : 'none'};">${shops}</div>`;
        });

        const rendered = blocks.filter(Boolean).join('');
        wrap.innerHTML = rendered || '<div style="text-align:center;color:#999;font-size:11px;padding:8px;">Không có shop khớp tìm kiếm</div>';

        // Toggle gập/mở khi click header (trừ checkbox "chọn cả nhóm")
        wrap.querySelectorAll('.tm-acc-group-head').forEach((head) => {
            head.onclick = (e) => {
                if (e.target.classList.contains('tm-acc-all')) return;
                const name = head.dataset.name;
                const shopsEl = wrap.querySelector(`.tm-acc-shops[data-acc="${head.dataset.acc}"]`);
                const nowOpen = !EXPANDED.has(name);
                if (nowOpen) EXPANDED.add(name); else EXPANDED.delete(name);
                saveExpanded();
                if (shopsEl) shopsEl.style.display = nowOpen ? 'grid' : 'none';
                const arrow = head.querySelector('.tm-acc-arrow');
                if (arrow) arrow.textContent = nowOpen ? '▾' : '▸';
            };
        });

        const syncAccAll = () => {
            wrap.querySelectorAll('.tm-acc-all').forEach((all) => {
                const boxes = [...wrap.querySelectorAll(`.tm-acc-checkbox[data-acc="${all.dataset.acc}"]`)];
                all.checked = boxes.length > 0 && boxes.every((b) => b.checked);
            });
        };
        wrap.querySelectorAll('.tm-acc-checkbox').forEach((cb) => {
            cb.onchange = () => {
                if (cb.checked) SELECTED.add(cb.value); else SELECTED.delete(cb.value);
                saveSelected();
                syncAccAll();
                renderSelectedSummary();
            };
        });
        wrap.querySelectorAll('.tm-acc-all').forEach((all) => {
            all.onchange = () => {
                wrap.querySelectorAll(`.tm-acc-checkbox[data-acc="${all.dataset.acc}"]`).forEach((cb) => {
                    cb.checked = all.checked;
                    if (all.checked) SELECTED.add(cb.value); else SELECTED.delete(cb.value);
                });
                saveSelected();
                renderSelectedSummary();
            };
        });
        syncAccAll();
        renderSelectedSummary();
    }

    /* Ô tóm tắt: tổng số shop đã chọn + tên shop, gom theo user — dễ nhìn/quản lý */
    function renderSelectedSummary() {
        const el = document.getElementById('tm-selected-summary');
        if (!el) return;
        const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

        if (SELECTED.size === 0) { el.style.display = 'none'; el.innerHTML = ''; return; }

        // Danh sách phẳng tên shop (sort theo accIdx cho ổn định, bỏ gom theo user)
        const names = [...SELECTED]
            .map((key) => {
                const sep = key.indexOf('::');
                return { idx: Number(key.slice(0, sep)), shop: key.slice(sep + 2) };
            })
            .sort((a, b) => a.idx - b.idx)
            .map((x) => esc(x.shop));

        el.style.display = '';
        el.innerHTML =
            `<div class="tm-sel-top">
                <span class="tm-sel-head">✅ Đã chọn ${SELECTED.size} shop</span>
                <button class="tm-sel-clear" id="tm-clear-sel">✕ Bỏ chọn</button>
            </div>
            <div class="tm-sel-shops">${names.join(', ')}</div>`;
        document.getElementById('tm-clear-sel').onclick = clearAllSelected;
    }

    /* Bỏ chọn TẤT CẢ shop đang tick (giữ vị trí cuộn + trạng thái gập/mở). */
    function clearAllSelected() {
        SELECTED.clear();
        saveSelected();
        document.querySelectorAll('#tm-shops .tm-acc-checkbox, #tm-shops .tm-acc-all')
            .forEach((cb) => { cb.checked = false; });
        renderSelectedSummary();
    }

    GM_registerMenuCommand('⚙ SHEIN Scraper Settings', () => {
        document.getElementById('tm-modal').style.display = 'flex';
    });

    initUI();
    setInterval(initUI, 3000);
})();
