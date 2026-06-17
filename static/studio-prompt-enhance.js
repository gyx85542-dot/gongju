/**
 * StudioPromptEnhance — prompt 文本框高度加倍 + Enhance 上拉选项
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

    let enhancePrompts = [];
    const openMenus = new Set();
    let scanScheduled = false;

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function getAllModes() {
        return (enhancePrompts || []).map((item) => ({
            id: item.id,
            label: item.name || item.id,
            kind: item.kind || 'llm',
            builtin: !!item.builtin,
            local: item.kind === 'local',
        }));
    }

    async function loadEnhancePrompts() {
        try {
            const res = await fetch('/api/enhance-system-prompts');
            if (!res.ok) return;
            const data = await res.json();
            enhancePrompts = Array.isArray(data.prompts) ? data.prompts : [];
        } catch (e) {
            enhancePrompts = [];
        }
        refreshOpenMenus();
    }

    function getPromptMeta(modeId) {
        return getAllModes().find((m) => m.id === modeId) || null;
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

    function collectEnhanceReferenceVideos() {
        if (typeof global.getEnhanceReferenceVideos === 'function') {
            return (global.getEnhanceReferenceVideos() || []).filter((url) => url);
        }
        return [];
    }

    function collectEnhanceReferenceAudios() {
        if (typeof global.getEnhanceReferenceAudios === 'function') {
            return (global.getEnhanceReferenceAudios() || []).filter((url) => url);
        }
        return [];
    }

    function collectEnhanceContext(prompt) {
        return {
            prompt: (prompt || '').trim(),
            images: collectEnhanceReferenceImages(),
            videos: collectEnhanceReferenceVideos(),
            audios: collectEnhanceReferenceAudios(),
        };
    }

    function canRunEnhance(modeId, ctx) {
        const meta = getPromptMeta(modeId);
        if (meta?.local) {
            if (modeId === 'image_upscale') return true;
            return !!ctx.prompt;
        }
        return !!(ctx.prompt || ctx.images.length || ctx.videos.length || ctx.audios.length);
    }

    function enhanceRequirementHint() {
        return '请先输入提示词或上传参考内容';
    }

    async function requestEnhance(prompt, modeId, context) {
        const ctx = context || collectEnhanceContext(prompt);
        const body = {
            prompt: prompt || '',
            mode: modeId,
        };
        const refs = (ctx.images || []).filter((ref) => ref?.url);
        if (refs.length) body.reference_images = refs;
        const videos = (ctx.videos || []).filter(Boolean);
        const audios = (ctx.audios || []).filter(Boolean);
        if (videos.length) body.reference_videos = videos;
        if (audios.length) body.reference_audios = audios;
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
        if (textarea.dataset.promptEnhanceHeightDone) return;
        const rows = parseInt(textarea.getAttribute('rows'), 10);
        if (rows > 0 && rows < 12) {
            textarea.setAttribute('rows', String(rows * 2));
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

    function renderModeOptions(menu, state) {
        const modes = getAllModes();
        const optionsHost = menu.querySelector('.prompt-enhance-options');
        if (!optionsHost) return;
        if (!modes.some((m) => m.id === state.selectedMode)) {
            state.selectedMode = modes[0]?.id || '';
        }
        optionsHost.innerHTML = modes
            .map(
                (mode) =>
                    `<button type="button" class="prompt-enhance-option${
                        mode.id === state.selectedMode ? ' active' : ''
                    }${mode.builtin ? '' : ' is-custom'}" data-mode="${escapeHtml(mode.id)}" role="option">${escapeHtml(mode.label)}</button>`
            )
            .join('');
        optionsHost.querySelectorAll('.prompt-enhance-option').forEach((btn) => {
            btn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                state.selectedMode = btn.dataset.mode;
                optionsHost.querySelectorAll('.prompt-enhance-option').forEach((el) => {
                    el.classList.toggle('active', el.dataset.mode === state.selectedMode);
                });
            });
        });
    }

    function refreshOpenMenus() {
        openMenus.forEach((state) => {
            if (state.menu) renderModeOptions(state.menu, state);
        });
    }

    function buildMenu(state) {
        const menu = document.createElement('div');
        menu.className = 'prompt-enhance-menu pullup-select-menu hidden';
        menu.setAttribute('role', 'listbox');
        menu.innerHTML =
            `<div class="prompt-enhance-menu-title">选择优化模式</div>` +
            `<div class="prompt-enhance-options"></div>`;

        renderModeOptions(menu, state);

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
            const ctx = collectEnhanceContext(ta.value);
            const modeId = state.selectedMode;
            if (!canRunEnhance(modeId, ctx)) {
                alert(enhanceRequirementHint());
                return;
            }
            setEnhanceLoading(state, true);
            try {
                const enhanced = await requestEnhance(ta.value, modeId, ctx);
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

        const modes = getAllModes();
        const state = {
            textarea,
            wrap,
            selectedMode: modes[0]?.id || '',
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
            renderModeOptions(menu, state);
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

    function bindPromptsChanged() {
        try {
            new BroadcastChannel('studio-api').onmessage = (event) => {
                if (event.data?.type === 'enhance-prompts-changed') loadEnhancePrompts();
            };
        } catch (e) {}
        window.addEventListener('message', (event) => {
            if (event.data?.type === 'enhance-prompts-changed') loadEnhancePrompts();
        });
    }

    function init(root) {
        loadEnhancePrompts().finally(() => scan(root || document));
        observeDynamic();
    }

    global.StudioPromptEnhance = {
        getAllModes,
        loadEnhancePrompts,
        requestEnhance,
        init,
        scan,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            bindGlobalClose();
            bindPromptsChanged();
            init();
        });
    } else {
        bindGlobalClose();
        bindPromptsChanged();
        init();
    }
})(typeof window !== 'undefined' ? window : globalThis);
