// ==UserScript==
// @name         SHEIN → Hub Scraper v30 (one-click)
// @namespace    http://tampermonkey.net/
// @version      31.1.0
// @description  Cào sản phẩm SHEIN vào Hub: 1 nút ở trang sản phẩm, hoặc gom link ở trang danh mục cho server cào nền. Không panel, không chọn shop, không phải dán token — tự lấy từ phiên đã đăng nhập admin.
// @author       shein-auto
// @match        *://*.shein.com/*
// @match        *://*.shein.co.uk/*
// @match        *://*.shein.de/*
// @match        *://*.shein.fr/*
// @match        *://*.shein.it/*
// @match        *://*.shein.es/*
// @connect      localhost
// @connect      127.0.0.1
// @connect      172.19.0.231
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    /* ====================== CONFIG ====================== */
    let SERVER = GM_getValue('serverUrl', 'http://localhost:3000');
    let TOKEN = GM_getValue('hubToken', '');

    const SELECTORS = {
        colorSwatches: '.main-sales-attr__color-container .radio-container, .radio-container[role="radio"], [class*="color-radio"]',
        colorNameLabel: '.color-block .sub-title, [class*="color-block"] .sub-title',
        price: '#productMainPriceId, .productPrice__main, [class*="product-intro__head-mainprice"]',
        productName: '.product-intro__head-name .fsp-element, h1.product-intro__head-name',
        sizeButtons: '.product-intro__size-choose [class*="inner"], .size-list [class*="size-item"], .product-intro__size-radio p',
        category: '.bread-crumb__inner',
        allProductImages: 'li img.fsp-element, .product-intro__main-img img, .main-img-container img',
        attrTrigger: '.common-entry__container:nth-child(1) .title, .product-intro__description-title',
        attrNames: '.product-intro__attr-list-textname',
        attrValues: '.product-intro__attr-list-textval',
        sizeGuideBtn: '.product-intro__size-guide, [class*="size-guide"], .size-guide-tag, [class*="size-chart"], .product-intro__size-guide-new',
    };

    /* ====================== UTILS ====================== */
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    /** Nhịp dò DOM. 150ms là quá thưa — mỗi lần chờ mất trung bình nửa nhịp cho không. */
    const POLL_MS = 60;
    /** Ảnh phải "đứng yên" bấy nhiêu mới coi là tải xong (SHEIN nạp ảnh theo nhiều đợt). */
    const SETTLE_MS = 250;

    const getOriginalImageUrl = (url) => {
        if (!url) return null;
        return url.replace(/_thumbnail_\d+x\d+/g, '').replace(/^\/\//, 'https://');
    };

    const getProductIdFromUrl = () => {
        const m = window.location.href.match(/-p-(\d+)\.html/);
        return m ? m[1] : null;
    };

    /**
     * SHEIN ghi size dạng "4 (S)" — số ở ngoài, size thật trong ngoặc → lấy phần trong ngoặc.
     *
     * Nhưng có loại nút ghi ngược: "XXS (Petite)", "XL (Tall)" — trong ngoặc là KIỂU DÁNG
     * chứ không phải size. Lấy bừa phần trong ngoặc sẽ biến size thành "Petite"/"Tall",
     * mất luôn size thật. Gặp ca đó thì giữ phần NGOÀI ngoặc.
     */
    const normalizeShein = (raw) => {
        if (!raw) return raw;
        const t = raw.trim();
        const m = t.match(/\(([^)]+)\)\s*$/);
        if (!m) return t;
        const inner = m[1].trim();
        if (isSkippedSize(inner)) return t.slice(0, m.index).trim() || inner;
        return inner;
    };

    // Nhãn KIỂU DÁNG (regular/tall/curve/plus/petite/maternity) và nhãn rác PP/PPP đứng MỘT MÌNH
    // thì không phải size → bỏ. Đi kèm size thật thì giữ.
    //   BỎ  : "Petite" · "Regular Sizes" · "PP" · "PPP" · "Petite PPP" · "Tall PPP"
    //   GIỮ : "Petite XXS" · "Tall XL" · "S" · "4XL" · "Men Plus" · "P"
    // Viết bằng regex literal, KHÔNG dựng qua chuỗi: '\s' trong chuỗi JS bị nuốt thành 's'.
    const SKIP_SIZE_RE =
        /^(?:(?:regular|tall|curve|plus|petite|pettie|maternity)\s+)?(?:regular|tall|curve|plus|petite|pettie|maternity|pp+)(?:\s+sizes?)?$/i;
    const isSkippedSize = (text) => SKIP_SIZE_RE.test((text || '').trim());

    /** Bỏ màu có tỉ lệ size hết hàng VƯỢT ngưỡng này. Chỉ áp khi sản phẩm có nhiều màu. */
    const OOS_DROP_RATIO = 0.5;

    /**
     * Nghỉ giữa hai màu để SHEIN không bắt captcha.
     *
     * Bấm màu liên tục sát nhau là dấu hiệu máy rõ nhất. Nhưng nghỉ ĐÚNG một con số cố định
     * cũng là một dấu hiệu — nhịp đều tăm tắp không giống người. Nên lấy ngẫu nhiên trong
     * khoảng [base, base×1.8] để mỗi lần một khác.
     *
     * Chỉnh qua menu Tampermonkey → "⏱ Đổi độ trễ giữa màu" nếu vẫn còn dính captcha.
     */
    let VARIANT_DELAY_MS = Number(GM_getValue('variantDelayMs', 900)) || 900;
    const humanPause = () => wait(VARIANT_DELAY_MS + Math.random() * VARIANT_DELAY_MS * 0.8);

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
        // 'smooth' cuộn có hoạt ảnh, phải chờ 300ms cho nó xong. 'instant' xong ngay,
        // chỉ cần 1 nhịp cho layout ổn định — mỗi cú bấm tiết kiệm ~240ms, có cả chục cú.
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        await wait(60);
        el.click();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }

    async function waitForChange(selector, prevText, timeoutMs = 1500) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const el = document.querySelector(selector);
            const text = el?.innerText?.trim() ?? '';
            if (text && text !== prevText) return text;
            await wait(POLL_MS);
        }
        return null;
    }

    /** Dò cho tới khi hàm trả về giá trị thật. Thay các `wait(800)` / `wait(1500)` cứng. */
    async function waitFor(fn, timeoutMs) {
        const start = Date.now();
        for (;;) {
            const v = fn();
            if (v) return v;
            if (Date.now() - start >= timeoutMs) return null;
            await wait(POLL_MS);
        }
    }

    const getGalleryImages = () => Array.from(new Set(
        Array.from(document.querySelectorAll(SELECTORS.allProductImages))
            .map((img) => getOriginalImageUrl(img.src || img.getAttribute('data-src') || img.dataset.src)),
    )).filter(Boolean);

    const gallerySignature = (imgs) => imgs.slice().sort().join('|');

    /**
     * Độ trễ đổi ảnh LỚN NHẤT đã quan sát trong lần cào này. Dùng để tự co giãn thời gian chờ.
     *
     * Vì sao cần: nhiều màu SHEIN dùng CHUNG bộ ảnh — bấm xong ảnh không đổi gì cả. Trước đây
     * mỗi màu như vậy ngồi chờ đủ 5 giây rồi mới kết luận "không đổi", đo thực tế mất 5,9s/màu.
     * Giờ học từ các màu trước: trang đổi ảnh trong 250ms thì chỉ cần chờ hơn 1 giây là đủ kết
     * luận. Trang chậm thì ngân sách tự nới ra, không cắt nhầm.
     */
    let _galLatency = 0;
    const galleryBudget = () => Math.min(5000, Math.max(1200, _galLatency * 3));

    async function waitForGalleryChange(prevSignature, timeoutMs = galleryBudget()) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (gallerySignature(getGalleryImages()) !== prevSignature) {
                _galLatency = Math.max(_galLatency, Date.now() - start);
                break;
            }
            await wait(POLL_MS);
        }
        let lastSig = gallerySignature(getGalleryImages());
        let lastChange = Date.now();
        while (Date.now() - lastChange < SETTLE_MS && Date.now() - start < timeoutMs + 2000) {
            await wait(POLL_MS);
            const sig = gallerySignature(getGalleryImages());
            if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
        }
        return getGalleryImages();
    }

    /**
     * Size này hết hàng chưa.
     *
     * Nút size thật là thẻ <p> bên trong, nhưng MỌI dấu hiệu hết hàng lại nằm ở thẻ CHA
     * mang role="radio" — HTML thật của SHEIN:
     *
     *   còn hàng : <div class="product-intro__size-radio ..."                            aria-disabled="false">
     *   hết hàng : <div class="product-intro__size-radio ... product-intro__size-radio_soldout" aria-disabled="true">
     *
     * Bản cũ trượt cả hai đường: regex chỉ có "sold-out"/"sold_out" mà SHEIN viết LIỀN
     * "soldout", còn aria-disabled thì đọc trên chính thẻ <p> nên luôn null. Hậu quả:
     * 0/4.504 sản phẩm trong Hub từng có dữ liệu hết hàng.
     */
    const isSoldOut = (btn) => {
        // Thẻ mang trạng thái: ưu tiên role="radio", lùi dần lên cha/ông.
        const holder = btn.closest('[role="radio"], [aria-disabled], li, label') || btn.parentElement;
        const cls = `${btn.className || ''} ${holder?.className || ''} ${btn.parentElement?.className || ''}`;
        return (
            // sold[-_ ]?out phủ cả "soldout", "sold-out", "sold_out", "sold out"
            /sold[-_\s]?out|out[-_\s]?of[-_\s]?stock|not[-_\s]?available|disabled/i.test(cls) ||
            holder?.getAttribute('aria-disabled') === 'true' ||
            btn.getAttribute('aria-disabled') === 'true' ||
            btn.hasAttribute('disabled') ||
            holder?.hasAttribute('disabled') === true
        );
    };

    function getAvailableSizesForCurrentColor() {
        const buttons = Array.from(document.querySelectorAll(SELECTORS.sizeButtons));
        const available = [];
        const sold = [];
        for (const btn of buttons) {
            const rawText = btn.textContent?.trim();
            if (!rawText) continue;
            if (isSkippedSize(rawText)) continue;
            const text = normalizeShein(rawText);
            if (isSkippedSize(text)) continue; // chuẩn hoá xong vẫn là kiểu dáng → không phải size
            if (isSoldOut(btn)) sold.push(text);
            else available.push(text);
        }
        return { available, sold };
    }

    /* ============= GM HTTP (CORS-free) ============= */
    function gmRequest({ url, method = 'GET', body = null, token = '' }) {
        return new Promise((resolve, reject) => {
            // Không kèm Authorization khi chưa có token → request đi bằng cookie phiên admin.
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers.Authorization = 'Bearer ' + token;
            GM_xmlhttpRequest({
                url,
                method,
                headers,
                data: body ? JSON.stringify(body) : null,
                onload: (resp) => {
                    let json;
                    try { json = JSON.parse(resp.responseText); } catch { json = { raw: resp.responseText }; }
                    if (resp.status >= 200 && resp.status < 300) resolve(json);
                    else reject(new Error(json?.error || `HTTP ${resp.status}`));
                },
                onerror: (e) => reject(new Error('Network error: ' + (e?.error || JSON.stringify(e)))),
                ontimeout: () => reject(new Error('Timeout')),
                timeout: 20000,
            });
        });
    }
    const apiHubCheck = (productId) => gmRequest({ url: `${SERVER}/admin/api/hub/check`, method: 'POST', body: { productId }, token: TOKEN });
    const apiHubIngest = (data) => gmRequest({ url: `${SERVER}/admin/api/hub/ingest`, method: 'POST', body: { data }, token: TOKEN });

    /**
     * Lấy token tự động từ phiên đã đăng nhập admin.
     *
     * GM_xmlhttpRequest gửi kèm cookie của host đích, mà trình duyệt này vốn đã đăng nhập
     * sẵn trang admin → server tự biết bạn là ai và trả về token của chính bạn. Nhờ vậy
     * không ai phải đi tìm rồi dán token bằng tay nữa (giao diện admin hiện cũng không còn
     * chỗ nào hiện token). Chỉ hỏi tay khi cách này thất bại.
     */
    async function ensureToken() {
        if (TOKEN) return TOKEN;
        const r = await gmRequest({ url: `${SERVER}/admin/api/me/token` });
        const t = (r && r.token || '').trim();
        if (!t) throw new Error('Tài khoản chưa có token — mở admin, vào Settings tạo token');
        TOKEN = t;
        GM_setValue('hubToken', TOKEN);
        return TOKEN;
    }

    /* ====================== CORE: cào → Hub ====================== */
    let BUSY = false;
    async function scrapeToHub() {
        if (BUSY) return;
        const productId = getProductIdFromUrl();
        if (!productId) { toast('⚠️ Không phải trang sản phẩm SHEIN', 'err'); return; }

        BUSY = true;
        _stateForProduct = productId; // tick sắp hiện là CỦA sản phẩm này
        setState('busy');
        setProgress(0);
        let ok = false;
        try {
            try {
                await ensureToken();
            } catch (e) {
                toast(`⚠️ ${e.message.includes('token') ? e.message : `Chưa đăng nhập — mở ${SERVER}/admin đăng nhập rồi bấm lại`}`, 'err', 6000);
                setState('error');
                return;
            }
            setProgress(4);

            // 0. Pre-check trùng Hub — bấm là báo ngay, chưa cào
            try {
                const r = await apiHubCheck(productId);
                // Tick vàng đã nói đủ, không cần toast.
                if (r && r.exists) { setState('done dup'); ok = true; return; }
            } catch (e) { console.warn('[HUB-SCRAPER] check lỗi (skip):', e.message); }
            setProgress(8);

            // 1. Attributes
            const attrBtn = document.querySelector(SELECTORS.attrTrigger);
            if (attrBtn) {
                await forceClick(attrBtn);
                // Chờ ĐÚNG lúc bảng thuộc tính hiện ra, thay vì ngủ cứng 800ms.
                await waitFor(() => document.querySelector(SELECTORS.attrNames), 1200);
            }
            const attributes = {};
            document.querySelectorAll(SELECTORS.attrNames).forEach((n, i) => {
                const val = document.querySelectorAll(SELECTORS.attrValues)[i]?.innerText.trim();
                if (val) attributes[n.innerText.replace(':', '').trim()] = val;
            });

            setProgress(14);

            // 2. Ảnh chung + size union
            const productImages = getGalleryImages().slice(0, 8);
            const initialSizes = Array.from(document.querySelectorAll(SELECTORS.sizeButtons))
                .map((el) => el.textContent.trim())
                .filter((raw) => raw && !isSkippedSize(raw))
                .map((raw) => normalizeShein(raw))
                .filter((sz) => sz && !isSkippedSize(sz));
            // KHÔNG seed bằng initialSizes: đó là size của màu đang chọn lúc mở trang, mà màu
            // đó có thể bị lọc bỏ. Chỉ gom từ màu được giữ; rỗng thì mới lùi về initialSizes.
            const allSizesSet = new Set();

            const data = {
                product_name: document.querySelector(SELECTORS.productName)?.innerText.trim(),
                category: document.querySelector(SELECTORS.category)?.innerText.replace(/\s+/g, ' ').trim(),
                sizes_available: initialSizes,
                variant_ids: [],
                variant_images: [],
                variant_price: [],
                listing_variations: { colors: [], sizes: initialSizes },
                available_matrix: {},
                oos_matrix: {},
                attributes,
                product_images: productImages,
                url: location.href,
                market: detectMarket(),
                scraped_at: new Date().toISOString(),
            };

            // 3. Loop từng màu (cào full màu)
            const swatches = document.querySelectorAll(SELECTORS.colorSwatches);
            const colorCounter = {};

            if (swatches.length > 0) {
                // Gom vào mảng trước, LỌC xong mới dựng data — để danh sách size tổng chỉ
                // tính trên màu được giữ, không lẫn size của màu đã bỏ.
                const variants = [];
                for (let i = 0; i < swatches.length; i++) {
                    if (i > 0) await humanPause(); // giãn nhịp giữa các màu, tránh dính captcha
                    const prevName = document.querySelector(SELECTORS.colorNameLabel)?.innerText.trim() ?? '';
                    const prevGallerySig = gallerySignature(getGalleryImages());
                    // Màu ĐANG được chọn sẵn (thường là màu đầu): bấm lại thì tên lẫn ảnh đều
                    // không đổi → chờ lâu cũng vô ích, cắt ngắn hẳn.
                    const alreadyActive = /(active|selected|checked)/i.test(swatches[i].className || '')
                        || swatches[i].getAttribute('aria-checked') === 'true';
                    await forceClick(swatches[i]);

                    let rawColorName = await waitForChange(SELECTORS.colorNameLabel, prevName, alreadyActive ? 200 : 1200);
                    const nameChanged = rawColorName !== null;
                    if (!rawColorName) {
                        rawColorName = swatches[i].querySelector('img')?.getAttribute('alt')?.trim() || 'Color' + (i + 1);
                    }

                    let finalColorName = rawColorName;
                    if (!colorCounter[rawColorName]) colorCounter[rawColorName] = 1;
                    else { colorCounter[rawColorName]++; finalColorName = `${rawColorName} ${colorCounter[rawColorName]}`; }

                    const currentId = getProductIdFromUrl() || 'Unknown';
                    const priceText = document.querySelector(SELECTORS.price)?.innerText.trim() || '0';
                    const variantImages = await waitForGalleryChange(prevGallerySig, nameChanged ? galleryBudget() : 900);

                    // Đọc size SAU khi ảnh đã ổn định, không phải ngay lúc tên màu đổi. SHEIN
                    // dựng lại danh sách size sau khi đổi màu; đọc sớm sẽ ăn trạng thái còn/hết
                    // của màu TRƯỚC. Chờ ảnh vốn đã tốn thời gian rồi nên không mất thêm gì.
                    const { available: availSizes, sold: soldSizes } = getAvailableSizesForCurrentColor();

                    variants.push({ name: finalColorName, id: currentId, price: priceText, images: variantImages, avail: availSizes, sold: soldSizes });

                    // Vòng lặp màu là phần dài nhất → trải từ 14% đến 82%.
                    setProgress(14 + (68 * (i + 1)) / swatches.length);
                }

                // ── Lọc màu hết hàng quá nửa ──────────────────────────────────────────
                // Chỉ áp khi có NHIỀU màu: sản phẩm 1 màu mà bỏ thì còn lại rỗng, vô nghĩa.
                // Màu không đọc được size nào (total = 0) thì giữ — thiếu dữ liệu không phải
                // bằng chứng hết hàng.
                const oosRatio = (v) => { const total = v.avail.length + v.sold.length; return total ? v.sold.length / total : 0; };
                let kept = variants;
                if (variants.length > 1) {
                    kept = variants.filter((v) => oosRatio(v) <= OOS_DROP_RATIO);
                    for (const v of variants.filter((x) => oosRatio(x) > OOS_DROP_RATIO)) {
                        console.log(`[HUB-SCRAPER] bỏ màu "${v.name}" — hết ${v.sold.length}/${v.avail.length + v.sold.length} size (${Math.round(oosRatio(v) * 100)}%)`);
                    }
                }

                // Không còn màu nào đạt → sản phẩm này không đáng list. Dừng hẳn, không đẩy
                // lên Hub một sản phẩm rỗng màu (xuống queue cũng fail).
                if (kept.length === 0) {
                    console.log(`[HUB-SCRAPER] Bỏ qua: cả ${variants.length} màu đều hết hơn ${OOS_DROP_RATIO * 100}% size`);
                    setState('done dup');
                    ok = true;
                    return;
                }

                for (const v of kept) {
                    v.avail.forEach((x) => allSizesSet.add(x));
                    v.sold.forEach((x) => allSizesSet.add(x));
                    data.listing_variations.colors.push(v.name);
                    data.variant_ids.push({ [v.name]: v.id });
                    data.variant_images.push({ [v.name]: v.images });
                    data.variant_price.push({ [v.name]: v.price });
                    data.available_matrix[v.name] = v.avail;
                    if (v.sold.length > 0) data.oos_matrix[v.name] = v.sold;
                }
            } else {
                const attrColorKey = Object.keys(attributes).find((k) => ['Color', 'Farbe', 'Couleur'].includes(k));
                const rawColorName =
                    document.querySelector(SELECTORS.colorNameLabel)?.innerText.trim()
                    || document.querySelector(SELECTORS.colorSwatches + ' img')?.getAttribute('alt')?.trim()
                    || (attrColorKey ? attributes[attrColorKey] : '')
                    || 'Default';
                const { available: availSizes, sold: soldSizes } = getAvailableSizesForCurrentColor();
                availSizes.forEach((s) => allSizesSet.add(s));
                soldSizes.forEach((s) => allSizesSet.add(s));
                const priceText = document.querySelector(SELECTORS.price)?.innerText.trim() || '0';
                const variantImages = getGalleryImages();
                data.listing_variations.colors.push(rawColorName);
                data.variant_ids.push({ [rawColorName]: getProductIdFromUrl() ?? 'Unknown' });
                data.variant_images.push({ [rawColorName]: variantImages.length ? variantImages : [...productImages] });
                data.variant_price.push({ [rawColorName]: priceText });
                data.available_matrix[rawColorName] = availSizes.length ? availSizes : initialSizes;
                if (soldSizes.length) data.oos_matrix[rawColorName] = soldSizes;
            }

            data.listing_variations.sizes = allSizesSet.size ? Array.from(allSizesSet) : initialSizes;
            setProgress(82);

            // 4. Size chart
            const sizeBtn = document.querySelector(SELECTORS.sizeGuideBtn)
                || Array.from(document.querySelectorAll('div, span, p, a, button'))
                    .find((el) => /Size Guide|Größentabelle|Guide des tailles/i.test(el.innerText || el.textContent));
            if (sizeBtn) {
                await forceClick(sizeBtn);
                const TABLE_SEL = '.bsc-common-size-table__content_inner-table, table, [class*="size-table"]';
                // Chờ bảng size xuất hiện rồi làm tiếp, thay vì ngủ cứng 1500ms.
                const table = await waitFor(() => {
                    const t = document.querySelector(TABLE_SEL);
                    return t && t.querySelector('tbody tr') ? t : null;
                }, 2000);
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

            // 5. Đẩy vào Hub
            setProgress(92);
            const res = await apiHubIngest(data);
            setProgress(100);
            ok = true;
            // Thành công thì tick xanh là đủ, không cần toast. Chỉ còn báo khi TRÙNG.
            //
            // Đã bỏ cảnh báo "vào Hub LOCAL — chưa nối Hub chung": máy này chủ đích chỉ dùng
            // hub local, nên cảnh báo đó sẽ nổ ở MỌI lần cào, thành nhiễu chứ không phải tin.
            // Server vẫn trả cờ `hubShared` nếu sau này cần bật lại.
            //
            // Lọc bớt màu hết hàng cũng là việc bình thường → tick xanh, không báo gì; màu nào
            // bị bỏ vẫn ghi ra console cho ai cần tra lại.
            if (res && res.duplicate) setState('done dup');
            else setState('done');
        } catch (e) {
            console.error('[HUB-SCRAPER]', e);
            toast('❌ ' + e.message, 'err', 6000);
            setState('error');
        } finally {
            BUSY = false;
            // Nhánh return sớm nào chưa kịp đặt trạng thái → trả nút về idle, không kẹt spinner.
            if (!ok) {
                const fab = document.getElementById('sh-hub-fab');
                if (fab && fab.classList.contains('busy')) setState('');
            }
        }
    }

    /* ====================== UI: 1 nút + toast ====================== */
    GM_addStyle(`
        #sh-hub-fab{position:fixed;right:22px;bottom:350px;z-index:2147483000;width:58px;height:58px;border-radius:16px;
            background:#000;color:#fff;display:flex;align-items:center;justify-content:center;cursor:grab;
            box-shadow:0 6px 20px rgba(0,0,0,.30);transition:background .12s ease;-webkit-tap-highlight-color:transparent;touch-action:none;user-select:none;}
        #sh-hub-fab:hover{background:#222;}
        #sh-hub-fab.dragging{cursor:grabbing;opacity:.9;transition:none;}
        #sh-hub-fab:active{transform:scale(.96);}
        #sh-hub-fab .sh-cart{width:30px;height:30px;display:block;}

        /* Trang thai: idle (gio hang) · busy (vong tron %) · done (tick) · error (X) */
        /* Chi khoa khi DANG chay. done/error van bam duoc de cao lai — tick giu luon nen
           neu khoa thi nut thanh vo dung. */
        #sh-hub-fab.busy{pointer-events:none;}
        #sh-hub-fab.busy{background:#333;}
        #sh-hub-fab.done{background:#0a8f3c;}
        #sh-hub-fab.done.dup{background:#b8860b;}
        #sh-hub-fab.error{background:#c0261c;}
        #sh-hub-fab.busy .sh-cart,#sh-hub-fab.done .sh-cart,#sh-hub-fab.error .sh-cart{display:none;}

        /* Vong tron tien do — quay -90deg de bat dau tu dinh */
        #sh-hub-fab .sh-ring{position:absolute;inset:0;width:58px;height:58px;display:none;transform:rotate(-90deg);}
        #sh-hub-fab.busy .sh-ring{display:block;}
        #sh-hub-fab .sh-ring circle{fill:none;stroke-width:3.5;}
        #sh-hub-fab .sh-ring .bg{stroke:rgba(255,255,255,.18);}
        #sh-hub-fab .sh-ring .fg{stroke:#fff;stroke-linecap:round;stroke-dasharray:157.08;stroke-dashoffset:157.08;
            transition:stroke-dashoffset .28s cubic-bezier(.4,0,.2,1);}
        /* inset:0 + canh giua — absolute khong toa do se bam goc flex, khong vao tam nut */
        #sh-hub-fab .sh-pct{position:absolute;inset:0;display:none;align-items:center;justify-content:center;
            font:600 13px/1 ui-monospace,monospace;color:#fff;letter-spacing:-.02em;font-variant-numeric:tabular-nums;}
        #sh-hub-fab.busy .sh-pct{display:flex;}

        /* Tick xanh / X do — inset 14px tren nut 58px = o vuong 30px canh giua chinh xac */
        #sh-hub-fab .sh-mark{position:absolute;inset:14px;width:auto;height:auto;display:none;}
        #sh-hub-fab.done .sh-check{display:block;}
        #sh-hub-fab.error .sh-cross{display:block;}
        #sh-hub-fab.done .sh-check,#sh-hub-fab.error .sh-cross{animation:sh-pop .22s cubic-bezier(.34,1.56,.64,1);}
        @keyframes sh-pop{from{transform:scale(.4);opacity:0;}to{transform:scale(1);opacity:1;}}
        @media (prefers-reduced-motion:reduce){
            #sh-hub-fab .sh-ring .fg{transition:none;}
            #sh-hub-fab.done .sh-check,#sh-hub-fab.error .sh-cross{animation:none;}
        }
        #sh-hub-toast{position:fixed;right:22px;bottom:420px;z-index:2147483000;max-width:280px;padding:10px 14px;border-radius:12px;
            font:600 13px/1.4 sans-serif;color:#fff;background:#000;box-shadow:0 6px 20px rgba(0,0,0,.28);opacity:0;transform:translateY(8px);
            transition:opacity .18s ease, transform .18s ease;pointer-events:none;}
        #sh-hub-toast.show{opacity:1;transform:translateY(0);}
        #sh-hub-toast.ok{background:#0a8f3c;}
        #sh-hub-toast.warn{background:#b8860b;}
        #sh-hub-toast.err{background:#c0261c;}
        #sh-hub-toast.info{background:#111;}

        /* ---- Gom link: chip dem + panel ---- */
        #sh-lc-chip{position:fixed;z-index:2147483000;display:none;align-items:center;gap:6px;padding:7px 12px;border-radius:12px;
            background:#000;color:#fff;font:700 12px/1 sans-serif;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.3);
            user-select:none;-webkit-tap-highlight-color:transparent;}
        #sh-lc-chip:hover{background:#222;}
        #sh-lc-chip b{color:#4ade80;font-variant-numeric:tabular-nums;}
        #sh-lc-panel{position:fixed;z-index:2147483001;width:296px;background:#111;color:#eee;border-radius:14px;display:none;
            flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.5);font-family:sans-serif;}
        #sh-lc-panel .hd{padding:11px 13px;font:700 13px sans-serif;display:flex;justify-content:space-between;align-items:center;
            border-bottom:1px solid #2a2a2a;}
        #sh-lc-panel .hd span:last-child{cursor:pointer;color:#888;}
        #sh-lc-panel .hd span:last-child:hover{color:#fff;}
        #sh-lc-panel .bd{padding:11px 13px;}
        #sh-lc-panel .hint{font-size:11px;color:#999;line-height:1.5;margin-bottom:9px;}
        #sh-lc-panel .hint b{color:#eee;}
        #sh-lc-panel .r{display:flex;gap:6px;margin-top:6px;}
        #sh-lc-panel button{flex:1;padding:9px;border:none;border-radius:8px;font:700 12px sans-serif;cursor:pointer;}
        #sh-lc-all{background:#2a2a2a;color:#eee;} #sh-lc-all:hover{background:#3a3a3a;}
        #sh-lc-clear{background:#7f1d1d;color:#fff;} #sh-lc-clear:hover{background:#991b1b;}
        #sh-lc-go{background:#4ade80;color:#000;} #sh-lc-go:hover{background:#6ee7a0;}
        #sh-lc-go:disabled{background:#2a2a2a;color:#666;cursor:default;}
        #sh-lc-log{font:11px/1.45 ui-monospace,monospace;color:#4ade80;margin-top:9px;max-height:118px;overflow:auto;white-space:pre-wrap;}
        /* Viền xanh trên sản phẩm đã gom — nhìn là biết đã nhặt cái nào */
        .sh-lc-picked{outline:3px solid #4ade80 !important;outline-offset:-3px;border-radius:6px;}
    `);

    // Icon giỏ hàng + mũi tên xuống (giống ảnh) — stroke trắng trên nền đen (phong cách SHEIN)
    const CART_ICON = `
        <svg class="sh-cart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3v6.5"/>
            <path d="M8.5 7 12 10.5 15.5 7"/>
            <path d="M3 5h1.6l1.7 9.4a1.6 1.6 0 0 0 1.6 1.3h8a1.6 1.6 0 0 0 1.6-1.25l1.05-5.75H8"/>
            <circle cx="9.5" cy="19.5" r="1.5"/>
            <circle cx="17" cy="19.5" r="1.5"/>
        </svg>`;

    // r=25 → chu vi 2πr = 157.08, khớp stroke-dasharray trong CSS.
    const RING = `
        <svg class="sh-ring" viewBox="0 0 58 58">
            <circle class="bg" cx="29" cy="29" r="25"/>
            <circle class="fg" cx="29" cy="29" r="25"/>
        </svg>
        <div class="sh-pct">0%</div>
        <svg class="sh-mark sh-check" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12.5 10 17.5 19.5 7"/>
        </svg>
        <svg class="sh-mark sh-cross" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round">
            <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/>
        </svg>`;

    let _toastTimer = null;
    function toast(msg, type = 'info', ms = 2200) {
        const el = document.getElementById('sh-hub-toast');
        if (!el) return;
        el.className = '';
        el.classList.add(type, 'show');
        el.textContent = msg;
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(() => el.classList.remove('show'), ms);
    }

    /* ---- Trạng thái nút: idle → busy(%) → done/error ----
       Tiến độ hiện ngay trên nút thay vì bắn toast từng bước, nên mắt chỉ phải nhìn 1 chỗ. */
    const RING_C = 157.08; // 2π × r(25)
    let _resetTimer = null;

    function setState(name) {
        const fab = document.getElementById('sh-hub-fab');
        if (!fab) return;
        fab.classList.remove('busy', 'done', 'error', 'dup');
        if (name) fab.classList.add(...name.split(' '));
        clearTimeout(_resetTimer);
        // Tick xanh / tick vàng GIỮ LUÔN, không tự biến mất — nó là dấu "sản phẩm này xong
        // rồi", nhìn nút là biết, khỏi cần toast. Chỉ tự xoá khi sang sản phẩm KHÁC
        // (xem resetStateIfProductChanged) hoặc khi bấm cào lại.
        // Riêng lỗi vẫn tự về idle sau 5s: nó là trạng thái nhất thời, giữ lại chỉ gây hiểu nhầm.
        if (name === 'error') _resetTimer = setTimeout(() => setState(''), 5000);
    }

    /**
     * Đổi sang sản phẩm khác thì trả nút về icon giỏ hàng.
     *
     * Cần vì tick giờ giữ luôn: không có cái này thì mở sản phẩm mới vẫn thấy tick xanh của
     * sản phẩm trước, tưởng đã cào rồi. SHEIN là SPA nên URL đổi mà trang không tải lại.
     */
    let _stateForProduct = null;
    function resetStateIfProductChanged() {
        const id = getProductIdFromUrl();
        if (id === _stateForProduct) return;
        _stateForProduct = id;
        const fab = document.getElementById('sh-hub-fab');
        if (fab && !fab.classList.contains('busy')) setState('');
    }

    function setProgress(pct) {
        const fab = document.getElementById('sh-hub-fab');
        if (!fab) return;
        const p = Math.max(0, Math.min(100, Math.round(pct)));
        const fg = fab.querySelector('.sh-ring .fg');
        const txt = fab.querySelector('.sh-pct');
        if (fg) fg.style.strokeDashoffset = String(RING_C * (1 - p / 100));
        if (txt) txt.textContent = p + '%';
    }

    // Vị trí nút đã lưu (kéo-thả). null = dùng mặc định góc trái-dưới.
    const loadFabPos = () => { try { return JSON.parse(GM_getValue('fabPos', 'null')); } catch { return null; } };
    function clampToViewport(el, left, top) {
        const w = el.offsetWidth || 58, h = el.offsetHeight || 58;
        return {
            left: Math.min(Math.max(4, left), window.innerWidth - w - 4),
            top: Math.min(Math.max(4, top), window.innerHeight - h - 4),
        };
    }
    function applyFabPos(el) {
        const p = loadFabPos();
        if (!p || typeof p.left !== 'number' || typeof p.top !== 'number') return;
        const c = clampToViewport(el, p.left, p.top);
        el.style.left = c.left + 'px';
        el.style.top = c.top + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    }
    function makeDraggable(fab) {
        let dragging = false, moved = false, justDragged = false, startX = 0, startY = 0, offX = 0, offY = 0;

        fab.addEventListener('pointerdown', (e) => {
            if (e.button && e.button !== 0) return;
            dragging = true; moved = false;
            startX = e.clientX; startY = e.clientY;
            const r = fab.getBoundingClientRect();
            offX = e.clientX - r.left; offY = e.clientY - r.top;
            try { fab.setPointerCapture(e.pointerId); } catch {}
        });
        fab.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return; // ngưỡng để phân biệt click vs kéo
            moved = true;
            fab.classList.add('dragging');
            const c = clampToViewport(fab, e.clientX - offX, e.clientY - offY);
            fab.style.left = c.left + 'px';
            fab.style.top = c.top + 'px';
            fab.style.right = 'auto';
            fab.style.bottom = 'auto';
            lcPlaceChip();
        });
        const end = (e) => {
            if (!dragging) return;
            dragging = false;
            fab.classList.remove('dragging');
            try { fab.releasePointerCapture(e.pointerId); } catch {}
            if (moved) {
                justDragged = true;
                const r = fab.getBoundingClientRect();
                GM_setValue('fabPos', JSON.stringify({ left: r.left, top: r.top }));
            }
        };
        fab.addEventListener('pointerup', end);
        fab.addEventListener('pointercancel', end);

        // Click chỉ chạy khi KHÔNG phải vừa kéo
        fab.addEventListener('click', (e) => {
            if (justDragged) { justDragged = false; e.stopImmediatePropagation(); e.preventDefault(); return; }
            scrapeToHub();
        });
    }

    /* ============= GOM LINK -> server tu cao (proxy + fingerprint) ============= */
    /**
     * Hai cách cào cho hai loại trang khác nhau:
     *   - Nút chính: đang ở TRANG SẢN PHẨM → trình duyệt của bạn tự cào ngay, ảnh đầy đủ.
     *   - Gom link : đang ở trang danh mục/tìm kiếm → nhặt link rồi giao server cào nền qua
     *                proxy + fingerprint, không chiếm trình duyệt và đỡ dính captcha.
     *
     * Danh sách link lưu qua GM_setValue nên sống sót khi cuộn, sang trang, hay F5.
     * Dùng chung SERVER / TOKEN / toast của v30, không dựng lại bộ cấu hình riêng.
     */
    const LC_PROD_SEL = 'a[href*="-p-"]';
    const lcIsProduct = (href) => /-p-\d+\.html/i.test(href || '');
    const lcClean = (href) => {
        try { const u = new URL(href, location.origin); return u.origin + u.pathname; }
        catch { return (href || '').split('?')[0]; }
    };
    let LC_LINKS = new Set((() => {
        try { return JSON.parse(GM_getValue('collectedLinks', '[]')); } catch { return []; }
    })());
    const lcSave = () => GM_setValue('collectedLinks', JSON.stringify([...LC_LINKS]));
    const lcLog = (m) => {
        const el = document.getElementById('sh-lc-log');
        if (el) el.textContent = m + (el.textContent ? '\n' + el.textContent : '');
    };

    /** Chip bám ngay TRÊN nút chính, kể cả khi nút bị kéo sang chỗ khác. */
    function lcPlaceChip() {
        const chip = document.getElementById('sh-lc-chip');
        const fab = document.getElementById('sh-hub-fab');
        if (!chip || !fab) return;
        const r = fab.getBoundingClientRect();
        chip.style.left = Math.max(4, r.right - chip.offsetWidth) + 'px';
        chip.style.top = Math.max(4, r.top - chip.offsetHeight - 8) + 'px';
        const panel = document.getElementById('sh-lc-panel');
        if (panel && panel.style.display === 'flex') {
            panel.style.left = Math.max(4, Math.min(window.innerWidth - panel.offsetWidth - 4, r.right - panel.offsetWidth)) + 'px';
            panel.style.top = Math.max(4, r.top - panel.offsetHeight - 8) + 'px';
        }
    }

    function lcRefresh() {
        const chip = document.getElementById('sh-lc-chip');
        if (!chip) return;
        const n = LC_LINKS.size;
        const panelOpen = document.getElementById('sh-lc-panel')?.style.display === 'flex';
        chip.innerHTML = '🔗 <b>' + n + '</b>';
        chip.style.display = n > 0 || panelOpen ? 'flex' : 'none';
        const go = document.getElementById('sh-lc-go');
        if (go) { go.textContent = '🕷️ Đẩy ' + n + ' link về Hub'; go.disabled = n === 0; }
        document.querySelectorAll(LC_PROD_SEL).forEach((a) => {
            a.classList.toggle('sh-lc-picked', LC_LINKS.has(lcClean(a.href)));
        });
        lcPlaceChip();
    }

    const lcToggle = (href) => {
        const u = lcClean(href);
        if (LC_LINKS.has(u)) LC_LINKS.delete(u); else LC_LINKS.add(u);
        lcSave(); lcRefresh();
    };

    // Shift + click 1 sản phẩm = nhặt/bỏ. Chặn điều hướng để không rời trang.
    document.addEventListener('click', (e) => {
        if (!e.shiftKey) return;
        const a = e.target.closest(LC_PROD_SEL);
        if (!a || !lcIsProduct(a.href)) return;
        e.preventDefault(); e.stopPropagation();
        lcToggle(a.href);
        lcLog('• ' + lcClean(a.href).slice(-45));
        toast('🔗 ' + LC_LINKS.size + ' link đã gom', 'info', 1200);
    }, true);

    // Phím G = nhặt hết sản phẩm đang hiện trên trang.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'g' && e.key !== 'G') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (/input|textarea|select/i.test(e.target.tagName) || e.target.isContentEditable) return;
        let n = 0;
        document.querySelectorAll(LC_PROD_SEL).forEach((a) => {
            if (!lcIsProduct(a.href)) return;
            const u = lcClean(a.href);
            if (!LC_LINKS.has(u)) { LC_LINKS.add(u); n++; }
        });
        lcSave(); lcRefresh();
        lcLog('⤵ Gom hết trang: +' + n + ' (tổng ' + LC_LINKS.size + ')');
        toast(n ? '⤵ +' + n + ' link (tổng ' + LC_LINKS.size + ')' : 'Không có link mới trên trang', n ? 'ok' : 'warn', 1800);
    });

    function lcTogglePanel(force) {
        const panel = document.getElementById('sh-lc-panel');
        if (!panel) return;
        panel.style.display = (force ?? (panel.style.display !== 'flex')) ? 'flex' : 'none';
        lcRefresh();
    }

    async function lcPush() {
        const links = [...LC_LINKS];
        if (!links.length) return;
        const go = document.getElementById('sh-lc-go');
        if (go) { go.disabled = true; go.textContent = 'Đang gửi…'; }
        lcLog('Đang gửi ' + links.length + ' link…');
        try {
            // Endpoint bỏ qua auth khi gọi từ localhost, nhưng vẫn kèm token nếu có — để
            // trỏ sang máy khác trong đội cũng chạy được.
            try { await ensureToken(); } catch { /* localhost thì không cần token */ }
            const r = await gmRequest({
                url: SERVER + '/admin/api/crawl/from-links',
                method: 'POST',
                body: { links, output: 'hub', concurrency: 3 },
                token: TOKEN,
            });
            if (!r || r.ok !== true) throw new Error(r?.error || 'Server từ chối');
            const n = r.started ?? links.length;
            lcLog('✅ Đã giao ' + n + ' link — server đang cào nền. Xem ở Admin → Hub.');
            toast('✅ Đã giao ' + n + ' link cho server', 'ok', 4000);
            LC_LINKS.clear(); lcSave(); lcRefresh();
        } catch (e) {
            lcLog('❌ ' + e.message);
            toast('❌ ' + e.message, 'err', 6000);
            lcRefresh();
        }
    }

    function initLinkCollector() {
        if (document.getElementById('sh-lc-chip')) return;

        const chip = document.createElement('div');
        chip.id = 'sh-lc-chip';
        chip.title = 'Link đã gom — bấm để mở bảng';
        chip.onclick = () => lcTogglePanel();
        document.body.appendChild(chip);

        const panel = document.createElement('div');
        panel.id = 'sh-lc-panel';
        panel.innerHTML =
            '<div class="hd"><span>🔗 Gom link → Hub</span><span id="sh-lc-x">✕</span></div>' +
            '<div class="bd">' +
            '<div class="hint">Giữ <b>Shift</b> + click sản phẩm để nhặt · phím <b>G</b> nhặt hết trang.<br>Server tự cào nền qua proxy, không chiếm trình duyệt.</div>' +
            '<div class="r"><button id="sh-lc-all">⤵ Gom hết trang</button><button id="sh-lc-clear">🗑 Xoá</button></div>' +
            '<div class="r"><button id="sh-lc-go">🕷️ Đẩy 0 link về Hub</button></div>' +
            '<div id="sh-lc-log"></div>' +
            '</div>';
        document.body.appendChild(panel);

        document.getElementById('sh-lc-x').onclick = () => lcTogglePanel(false);
        document.getElementById('sh-lc-all').onclick = () =>
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'G' }));
        document.getElementById('sh-lc-clear').onclick = () => {
            LC_LINKS.clear(); lcSave(); lcRefresh(); lcLog('Đã xoá hết.');
        };
        document.getElementById('sh-lc-go').onclick = lcPush;
        lcRefresh();
    }

    function initUI() {
        if (document.getElementById('sh-hub-fab')) return;
        const fab = document.createElement('div');
        fab.id = 'sh-hub-fab';
        fab.title = 'Cào sản phẩm vào Hub (kéo để di chuyển)';
        fab.innerHTML = CART_ICON + RING;
        document.body.appendChild(fab);
        applyFabPos(fab);
        makeDraggable(fab);

        const t = document.createElement('div');
        t.id = 'sh-hub-toast';
        document.body.appendChild(t);

        initLinkCollector();
    }

    // Giữ nút trong màn hình khi resize
    window.addEventListener('resize', () => {
        const fab = document.getElementById('sh-hub-fab');
        if (fab && fab.style.left) {
            const c = clampToViewport(fab, parseFloat(fab.style.left), parseFloat(fab.style.top));
            fab.style.left = c.left + 'px'; fab.style.top = c.top + 'px';
        }
        lcPlaceChip();
    });

    /* ============= Cấu hình qua menu Tampermonkey ============= */
    // Chỉ còn hỏi địa chỉ server. Token tự lấy từ phiên đăng nhập admin (xem ensureToken).
    function configure() {
        const s = prompt('Địa chỉ worker (mặc định http://localhost:3000):', SERVER);
        if (s === null) return;
        SERVER = s.trim().replace(/\/$/, '');
        GM_setValue('serverUrl', SERVER);
        toast('✅ Đã lưu: ' + SERVER, 'ok');
    }
    GM_registerMenuCommand('⚙ Đổi địa chỉ worker', configure);

    // Dùng khi đổi tài khoản admin: xoá token cũ rồi lấy lại theo phiên đang đăng nhập.
    GM_registerMenuCommand('🔑 Lấy lại token', async () => {
        TOKEN = '';
        GM_setValue('hubToken', '');
        try {
            await ensureToken();
            toast('✅ Đã lấy token mới', 'ok');
        } catch (e) {
            toast(`❌ ${e.message} — nhớ đăng nhập ${SERVER}/admin trước`, 'err', 6000);
        }
    });
    // Dính captcha thì tăng số này lên (vd 2000). Cào chậm hơn nhưng đỡ bị chặn.
    GM_registerMenuCommand('⏱ Đổi độ trễ giữa màu', () => {
        const v = prompt(`Nghỉ bao nhiêu ms giữa 2 màu?\n(thực tế random trong khoảng x1–x1.8; dính captcha thì tăng lên)`, String(VARIANT_DELAY_MS));
        if (v === null) return;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) { toast('❌ Phải là số ≥ 0', 'err'); return; }
        VARIANT_DELAY_MS = Math.round(n);
        GM_setValue('variantDelayMs', VARIANT_DELAY_MS);
        toast(`✅ Nghỉ ${VARIANT_DELAY_MS}–${Math.round(VARIANT_DELAY_MS * 1.8)}ms giữa mỗi màu`, 'ok', 3500);
    });
    GM_registerMenuCommand('🔗 Mở bảng gom link', () => lcTogglePanel(true));
    GM_registerMenuCommand('↺ Reset vị trí nút', () => {
        GM_setValue('fabPos', 'null');
        const fab = document.getElementById('sh-hub-fab');
        if (fab) { fab.style.right = '22px'; fab.style.bottom = '350px'; fab.style.left = 'auto'; fab.style.top = 'auto'; }
        toast('↺ Đã reset vị trí nút (phải-dưới, cao 350px)', 'ok');
    });

    initUI();
    setInterval(() => { initUI(); lcRefresh(); resetStateIfProductChanged(); }, 3000); // SHEIN là SPA — giữ nút, cập nhật viền link, xoá tick khi sang sp khác
})();
