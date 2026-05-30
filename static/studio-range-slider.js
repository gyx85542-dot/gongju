(function () {
    'use strict';

    var FILL_VAR = '--studio-range-fill';
    var BOUND = 'data-studio-range-bound';

    function fillPct(el) {
        var min = Number(el.min);
        var max = Number(el.max);
        var val = Number(el.value);
        var lo = Number.isFinite(min) ? min : 0;
        var hi = Number.isFinite(max) ? max : 100;
        if (hi <= lo) return '0%';
        var pct = ((val - lo) / (hi - lo)) * 100;
        return Math.min(100, Math.max(0, pct)) + '%';
    }

    function sync(el) {
        if (!(el instanceof HTMLInputElement) || el.type !== 'range') return;
        el.style.setProperty(FILL_VAR, fillPct(el));
    }

    function bind(el) {
        sync(el);
        if (el.getAttribute(BOUND)) return;
        el.setAttribute(BOUND, '1');
        el.addEventListener('input', function () { sync(el); });
        el.addEventListener('change', function () { sync(el); });
    }

    function scan(root) {
        var scope = root && root.querySelectorAll ? root : document;
        scope.querySelectorAll('input[type="range"]').forEach(bind);
    }

    function boot() {
        scan(document);
        if (typeof MutationObserver === 'undefined') return;
        new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                m.addedNodes.forEach(function (node) {
                    if (node instanceof HTMLInputElement && node.type === 'range') bind(node);
                    else if (node instanceof Element) scan(node);
                });
            });
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    window.StudioRangeSlider = { sync: sync, bind: bind, scan: scan };
})();
