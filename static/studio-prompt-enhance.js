/**
 * StudioPromptEnhance — prompt 文本框高度加倍 + Enhance 上拉选项（前端 Mock）
 */
(function (global) {
    'use strict';

    const PROMPT_TEXTAREA_SELECTOR = [
        'textarea#promptInput',
        'textarea#globalPromptInput',
        '.options-panel textarea.nano-input',
        '.options-panel textarea.wf-textarea',
    ].join(', ');

    const SKIP_SELECTOR = '[data-prompt-enhance-skip], .prompt-enhance-wrap textarea';

    const MODES = [
        { id: 'storyboard_grid', label: '九宫格分镜' },
        { id: 'video_gen', label: '视频生成' },
        { id: 'character_turnaround', label: '人物三视图' },
        { id: 'image_upscale', label: '图片高清放大' },
        { id: 'panorama', label: '全景图' },
        { id: 'general', label: '常规优化' },
    ];

    const LOCAL_ENHANCE_MODES = new Set(['character_turnaround', 'image_upscale']);
    const VISION_ENHANCE_MODES = new Set(['panorama']);

    const openMenus = new Set();
    let scanScheduled = false;

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function enhanceErrorMessage(payload, fallback) {
        const detail = payload && payload.detail;
        if (typeof detail === 'string' && detail.trim()) return detail;
        if (Array.isArray(detail)) {
            const parts = detail
                .map((item) => (item && (item.msg || item.message)) || '')
                .filter(Boolean);
            if (parts.length) return parts.join('；');
        }
        return fallback || 'Enhance 失败';
    }

    function collectEnhanceReferenceImages() {
        if (global.StudioRefUpload?.getReferenceList) {
            return (global.StudioRefUpload.getReferenceList() || []).filter((ref) => ref?.url);
        }
        return [];
    }

    function canRunEnhance(modeId, prompt, refs) {
        if (LOCAL_ENHANCE_MODES.has(modeId)) return true;
        if (VISION_ENHANCE_MODES.has(modeId) && refs.length) return true;
        return !!(prompt || '').trim();
    }

    async function requestEnhance(prompt, modeId, referenceImages) {
        const body = { prompt: prompt || '', mode: modeId };
        const refs = (referenceImages || []).filter((ref) => ref?.url);
        if (refs.length) body.reference_images = refs;
        const res = await fetch('/api/prompt/enhance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(enhanceErrorMessage(data, 'Enhance 请求失败'));
        }
        return String(data.prompt || '').trim();
    }

    function setEnhanceLoading(state, loading) {
        const trigger = state.trigger;
        const confirm = state.menu?.querySelector('.prompt-enhance-confirm');
        if (trigger) {
            trigger.disabled = loading;
            if (!trigger.dataset.enhanceLabel) {
                trigger.dataset.enhanceLabel =
                    trigger.querySelector('.pullup-select-current')?.textContent || 'Enhance';
            }
            const label = trigger.querySelector('.pullup-select-current');
            if (label) label.textContent = loading ? '处理中…' : trigger.dataset.enhanceLabel;
        }
        if (confirm) confirm.disabled = loading;
    }

    function doubleTextareaHeight(textarea) {
        const rows = parseInt(textarea.getAttribute('rows'), 10);
        if (rows > 0) textarea.setAttribute('rows', String(rows * 2));
        if (textarea.dataset.promptEnhanceHeightDone) return;
        const minH = parseFloat(getComputedStyle(textarea).minHeight);
        if (minH > 0 && Number.isFinite(minH)) {
            textarea.style.minHeight = `${minH * 2}px`;
        }
        textarea.dataset.promptEnhanceHeightDone = '1';
    }

    function dispatchInput(textarea) {
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function refreshEnhanceIcon(trigger) {
        if (global.lucide?.createIcons && trigger) {
            global.lucide.createIcons({ nodes: [trigger] });
        }
    }

    function closeMenu(state) {
        if (!state?.menu) return;
        state.menu.classList.add('hidden');
        openMenus.delete(state);
    }

    function closeAllMenus(except) {
        [...openMenus].forEach((state) => {
            if (state !== except) closeMenu(state);
        });
    }

    function buildMenu(state) {
        const menu = document.createElement('div');
        menu.className = 'prompt-enhance-menu pullup-select-menu hidden';
        menu.setAttribute('role', 'listbox');
        menu.innerHTML = `<div class="prompt-enhance-menu-title">选择优化模式</div>`;

        MODES.forEach((mode, index) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'prompt-enhance-option' + (index === 0 ? ' active' : '');
            btn.dataset.mode = mode.id;
            btn.setAttribute('role', 'option');
            btn.textContent = mode.label;
            btn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                state.selectedMode = mode.id;
                menu.querySelectorAll('.prompt-enhance-option').forEach((el) => {
                    el.classList.toggle('active', el.dataset.mode === mode.id);
                });
            });
            menu.appendChild(btn);
        });

        const actions = document.createElement('div');
        actions.className = 'prompt-enhance-menu-actions';
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'prompt-enhance-confirm';
        confirm.textContent = '确认';
        confirm.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const ta = state.textarea;
            const original = (ta.value || '').trim();
            const modeId = state.selectedMode;
            const refs = collectEnhanceReferenceImages();
            if (!canRunEnhance(modeId, original, refs)) {
                alert(
                    VISION_ENHANCE_MODES.has(modeId)
                        ? '请先输入提示词或上传参考图片'
                        : '请先输入提示词'
                );
                return;
            }
            setEnhanceLoading(state, true);
            try {
                const enhanced = await requestEnhance(ta.value, modeId, refs);
                if (!enhanced) {
                    throw new Error('未获得优化结果');
                }
                ta.value = enhanced;
                dispatchInput(ta);
                if (typeof global.autoGrow === 'function') global.autoGrow(ta);
                closeMenu(state);
            } catch (err) {
                alert(err && err.message ? err.message : 'Enhance 失败');
            } finally {
                setEnhanceLoading(state, false);
            }
        });
        actions.appendChild(confirm);
        menu.appendChild(actions);
        return menu;
    }

    function wrapTextarea(textarea) {
        if (!textarea || textarea.closest('.prompt-enhance-wrap')) return;
        if (textarea.dataset.promptEnhanceWrapped === '1') return;
        if (textarea.matches(SKIP_SELECTOR)) return;

        const parent = textarea.parentElement;
        if (!parent) return;

        doubleTextareaHeight(textarea);
        textarea.dataset.promptEnhanceWrapped = '1';

        const wrap = document.createElement('div');
        wrap.className = 'prompt-enhance-wrap';

        const actions = document.createElement('div');
        actions.className = 'prompt-enhance-actions';

        const state = {
            textarea,
            wrap,
            selectedMode: MODES[0].id,
            menu: null,
            trigger: null,
        };

        const selectWrap = document.createElement('div');
        selectWrap.className =
            'prompt-enhance-select-wrap pullup-select-wrap pullup-select-wrap--compact';

        const menu = buildMenu(state);
        state.menu = menu;
        menu.classList.add('pullup-open-up');

        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'pullup-select-trigger';
        trigger.innerHTML =
            '<span class="pullup-select-current">Enhance</span>' +
            '<span class="pullup-select-chevron" aria-hidden="true">' +
            '<i data-lucide="chevron-up" width="12" height="12"></i></span>';
        state.trigger = trigger;

        trigger.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const isOpen = !menu.classList.contains('hidden');
            closeAllMenus();
            if (isOpen) {
                closeMenu(state);
                return;
            }
            menu.classList.remove('hidden');
            openMenus.add(state);
        });

        selectWrap.appendChild(trigger);
        selectWrap.appendChild(menu);
        actions.appendChild(selectWrap);

        parent.insertBefore(wrap, textarea);
        wrap.appendChild(textarea);
        wrap.appendChild(actions);
        refreshEnhanceIcon(trigger);
    }

    function collectTextareas(root) {
        const scope = root && root.querySelectorAll ? root : document;
        return [...scope.querySelectorAll(PROMPT_TEXTAREA_SELECTOR)].filter(
            (ta) => ta.matches(PROMPT_TEXTAREA_SELECTOR) && !ta.closest('.prompt-enhance-wrap') && !ta.matches(SKIP_SELECTOR)
        );
    }

    function scan(root) {
        collectTextareas(root).forEach(wrapTextarea);
    }

    function scheduleScan(root) {
        if (scanScheduled) return;
        scanScheduled = true;
        requestAnimationFrame(() => {
            scanScheduled = false;
            scan(root);
        });
    }

    function observeDynamic() {
        const selectors = ['#dynamicPanel', '.options-panel'];
        selectors.forEach((sel) => {
            const el = document.querySelector(sel);
            if (!el) return;
            new MutationObserver(() => scheduleScan(el)).observe(el, {
                childList: true,
                subtree: true,
            });
        });
    }

    function bindGlobalClose() {
        document.addEventListener(
            'click',
            (event) => {
                if (event.target.closest('.prompt-enhance-select-wrap')) return;
                closeAllMenus();
            },
            true
        );
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeAllMenus();
        });
    }

    function init(root) {
        scan(root || document);
        observeDynamic();
    }

    global.StudioPromptEnhance = {
        MODES,
        requestEnhance,
        init,
        scan,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            bindGlobalClose();
            init();
        });
    } else {
        bindGlobalClose();
        init();
    }
})(typeof window !== 'undefined' ? window : globalThis);
