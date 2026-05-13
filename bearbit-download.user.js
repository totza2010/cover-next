// ==UserScript==
// @name         BearBit - ปุ่มดาวน์โหลดตรง v6
// @namespace    http://tampermonkey.net/
// @version      6.1
// @description  ปุ่มดาวน์โหลดตรงพร้อมสถานะและสีตามขนาดไฟล์ รองรับหน้า listing และหน้าผู้อัพโหลด
// @author       you
// @match        https://bearbit.org/viewno18sbx.php*
// @match        https://bearbit.org/viewbrsb.php*
// @match        https://bearbit.org/viewno18sb.php*
// @match        https://bearbit.org/viewno18.php*
// @match        https://bearbit.org/viewbr.php*
// @match        https://bearbit.org/upfin1.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      bearbit.org
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    /* ─────────────────────────────────────────────
       สีปุ่ม
       status-new  → สีตามขนาดไฟล์ (เหมือน VIP btn ของเว็บ)
       status-tor  → ม่วง   (ได้รับ torrent ไปแล้ว)
       status-done → น้ำเงินเข้ม (ดาวน์โหลดไฟล์เสร็จแล้ว)
       status-none → เทา
    ───────────────────────────────────────────── */
    GM_addStyle(`
        .bb-dl-direct {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: bold;
            text-decoration: none !important;
            cursor: pointer;
            border: none;
            line-height: 1.8;
            vertical-align: middle;
            white-space: nowrap;
            color: #fff !important;
        }

        /* ── new: สีตามขนาด (ไล่จากเล็กไปใหญ่ = เขียว → เหลือง → ส้ม → แดง) ── */
        .bb-dl-direct.status-new.zone-small  {
            background: linear-gradient(135deg, #22c55e, #16a34a);
        }
        .bb-dl-direct.status-new.zone-medium {
            background: linear-gradient(135deg, #f59e0b, #d97706);
        }
        .bb-dl-direct.status-new.zone-large  {
            background: linear-gradient(135deg, #f97316, #ea580c);
        }
        .bb-dl-direct.status-new.zone-xlarge {
            background: linear-gradient(135deg, #ef4444, #b91c1c);
        }
        .bb-dl-direct.status-new.zone-unknown {
            background: linear-gradient(135deg, #3b82f6, #2563eb);
        }

        /* ── tor: ม่วง ── */
        .bb-dl-direct.status-tor {
            background: linear-gradient(135deg, #a855f7, #7c3aed);
            opacity: 0.9;
        }

        /* ── done: น้ำเงินเข้ม ── */
        .bb-dl-direct.status-done {
            background: linear-gradient(135deg, #0ea5e9, #0369a1);
            opacity: 0.85;
        }

        /* ── none: เทา ── */
        .bb-dl-direct.status-none {
            background: #9ca3af;
        }

        /* placeholder ระหว่างโหลด */
        .bb-dl-placeholder {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 12px;
            color: #aaa;
            background: #e5e7eb;
            vertical-align: middle;
            white-space: nowrap;
        }

        /* upfin1 specific */
        .bb-upfin-cell {
            display: block;
            margin-top: 5px;
        }
    `);

    /* ─────────────────────────────────────────────
       แยกขนาดไฟล์ออกจาก text แล้วคืน { sizeText, zone }
       รองรับรูปแบบ: "(3.13 GB)", "3.13 GB", "800 MB"
    ───────────────────────────────────────────── */
    function parseSize(text) {
        if (!text) return { sizeText: null, zone: 'unknown' };

        const m = text.match(/([\d,]+(?:\.\d+)?)\s*(TB|GB|MB)/i);
        if (!m) return { sizeText: null, zone: 'unknown' };

        let gb = parseFloat(m[1].replace(',', ''));
        const unit = m[2].toUpperCase();
        if (unit === 'MB') gb /= 1024;
        if (unit === 'TB') gb *= 1024;

        const sizeText = `${m[1]} ${m[2]}`;
        let zone;
        if      (gb <= 4)  zone = 'small';
        else if (gb <= 10) zone = 'medium';
        else if (gb <= 30) zone = 'large';
        else               zone = 'xlarge';

        return { sizeText, zone };
    }

    /* ─────────────────────────────────────────────
       Fetch details.php → dlUrl + status
    ───────────────────────────────────────────── */
    function fetchDetails(torrentId) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: window.location.origin + '/details.php?id=' + torrentId,
                onload(res) {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(res.responseText, 'text/html');

                    const dlAnchor = doc.querySelector('a[href^="downloadnew.php?id="]');
                    const dlUrl = dlAnchor ? dlAnchor.getAttribute('href') : null;

                    // รวม text ของ h1 ทั้งหมดก่อน แล้วค่อยตัดสิน
                    // done > tor เพราะหน้าที่โหลดเสร็จจะมีทั้งสอง text พร้อมกัน
                    const allH1 = Array.from(doc.querySelectorAll('h1'))
                        .map(h => h.textContent).join(' ');
                    let status = 'new';
                    if      (allH1.includes('ดาวน์โหลดเสร็จแล้ว')) status = 'done';
                    else if (allH1.includes('ได้รับไปแล้ว'))        status = 'tor';

                    resolve({ dlUrl, status });
                },
                onerror()   { resolve({ dlUrl: null, status: 'none' }); },
                ontimeout() { resolve({ dlUrl: null, status: 'none' }); },
            });
        });
    }

    /* ─────────────────────────────────────────────
       สร้างปุ่มดาวน์โหลด
       - status-new  → สีตาม zone พร้อมแสดงขนาด
       - status-tor  → แสดงขนาดด้วย (รู้ว่าใหญ่แค่ไหน)
       - status-done → แสดงขนาดด้วย
    ───────────────────────────────────────────── */
    function makeButton(dlUrl, status, { sizeText, zone } = {}) {
        const sizeLabel = sizeText ? ` (${sizeText})` : '';

        const labels = {
            new:  `⬇ ดาวน์โหลด${sizeLabel}`,
            tor:  `📥 รับแล้ว${sizeLabel}`,
            done: `✓ โหลดแล้ว${sizeLabel}`,
            none: '✖ ไม่พบลิงก์',
        };

        const btn = document.createElement('a');

        // class หลัก + status + zone (zone ใช้แค่ตอน new)
        const classes = ['bb-dl-direct', `status-${status}`];
        if (status === 'new') classes.push(`zone-${zone ?? 'unknown'}`);
        btn.className = classes.join(' ');

        btn.textContent = labels[status] ?? labels.none;

        if (dlUrl) {
            btn.href = window.location.origin + '/' + dlUrl;
        } else {
            btn.href = '#';
            btn.addEventListener('click', e => e.preventDefault());
        }

        return btn;
    }

    /* ═══════════════════════════════════════════
       PAGE TYPE A — viewno18sbx / viewbrsb / etc.
       ขนาดไฟล์: อ่านจาก .bb-vip-btn ก่อนลบ
    ═══════════════════════════════════════════ */
    async function processListingRow(row) {
        const link = row.querySelector('a[href*="details.php?id="]');
        if (!link) return;

        const match = link.href.match(/details\.php\?id=(\d+)/);
        if (!match) return;
        const torrentId = match[1];

        const actionsDiv = row.querySelector('div.bb-actions');
        if (!actionsDiv) return;

        // อ่านขนาดจาก VIP btn ก่อนลบ
        const vipBtn = actionsDiv.querySelector('.bb-vip-btn');
        const sizeInfo = parseSize(vipBtn?.textContent ?? '');
        vipBtn?.remove();

        // placeholder
        const placeholder = document.createElement('span');
        placeholder.className = 'bb-dl-placeholder';
        placeholder.textContent = sizeInfo.sizeText ? `… (${sizeInfo.sizeText})` : '…';

        const bookmark = actionsDiv.querySelector('.bb-bookmark-btn');
        bookmark
            ? actionsDiv.insertBefore(placeholder, bookmark)
            : actionsDiv.appendChild(placeholder);

        const { dlUrl, status } = await fetchDetails(torrentId);
        placeholder.replaceWith(makeButton(dlUrl, status, sizeInfo));
    }

    /* ═══════════════════════════════════════════
       PAGE TYPE B — upfin1.php
       ขนาดไฟล์: อ่านจาก td ลำดับที่ 6 (ขนาดไฟล์ column)
       columns: Type(0) | ชื่อ(1) | ฟรี(2) | โบนัส(3) |
                ลงวันที่(4) | ผ่านมาแล้ว(5) | ขนาดไฟล์(6) | ...
    ═══════════════════════════════════════════ */
    async function processUpfinRow(row) {
        const link = row.querySelector('a[href*="details.php?id="]');
        if (!link) return;

        const match = link.href.match(/details\.php\?id=(\d+)/);
        if (!match) return;
        const torrentId = match[1];

        const titleTd = link.closest('td');
        if (!titleTd) return;

        // อ่านขนาดไฟล์จาก column ที่ 6
        const tds = row.querySelectorAll('td');
        const sizeInfo = parseSize(tds[6]?.textContent ?? '');

        // placeholder
        const placeholder = document.createElement('span');
        placeholder.className = 'bb-dl-placeholder bb-upfin-cell';
        placeholder.textContent = sizeInfo.sizeText ? `… (${sizeInfo.sizeText})` : '…';

        titleTd.appendChild(placeholder);

        const { dlUrl, status } = await fetchDetails(torrentId);
        const btn = makeButton(dlUrl, status, sizeInfo);
        btn.classList.add('bb-upfin-cell');
        placeholder.replaceWith(btn);
    }

    /* ─────────────────────────────────────────────
       Concurrency limiter
    ───────────────────────────────────────────── */
    async function runConcurrent(items, fn, limit = 5) {
        const executing = new Set();
        for (const item of items) {
            const p = Promise.resolve()
                .then(() => fn(item))
                .finally(() => executing.delete(p));
            executing.add(p);
            if (executing.size >= limit) await Promise.race(executing);
        }
        await Promise.all(executing);
    }

    /* ─────────────────────────────────────────────
       Entry point
    ───────────────────────────────────────────── */
    function init() {
        const path = window.location.pathname;

        if (path.startsWith('/upfin1.php')) {
            const rows = Array.from(
                document.querySelectorAll('tr:has(td.tablea)')
            ).filter(row => row.querySelector('a[href*="details.php?id="]'));

            if (rows.length === 0) return;
            runConcurrent(rows, processUpfinRow, 5);
        } else {
            const rows = Array.from(document.querySelectorAll('tr.bb-torrent-row'));
            if (rows.length === 0) return;
            runConcurrent(rows, processListingRow, 5);
        }
    }

    init();
})();
