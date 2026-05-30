/**
 * StudioPullupSelect — floating card dropdown (Aspect-style) for native <select>.
 * Visual layer only: preserves value binding, change events, and keyboard use.
 */
(function (global) {
    'use strict';

    const DEFAULT_SELECTOR =
        'select.size-select, select.small-select, select.pfield-select, select.provider-select, select.select-lite, select.wf-select, select.compact-select';

    const SKIP_SELECTOR = '[data-pullup-skip], .pullup-select-native';

    const openMenus = new Set();

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function getSelectedOption(select) {
        const idx = select.selectedIndex;
        if (idx < 0) return null;
        return select.options[idx] || null;
    }

    function optionLabel(option, select) {
        if (global.StudioProviderLabel?.optionLabel) {
            return global.StudioProviderLabel.optionLabel(option, select);
        }
        if (!option) return '';
        return option.textContent?.trim() || option.label || option.value || '';
    }

    function hookSelectValue(select, onChange) {
        if (select._pullupValueHooked) return;
        select._pullupValueHooked = true;
        const proto = HTMLSelectElement.prototype;
        ['value', 'selectedIndex', 'disabled'].forEach((key) => {
            const desc = Object.getOwnPropertyDescriptor(proto, key);
            if (!desc || !desc.get || !desc.set) return;
            Object.defineProperty(select, key, {
                configurable: true,
                enumerable: desc.enumerable,
                get() {
                    return desc.get.call(this);
                },
                set(next) {
                    desc.set.call(this, next);
                    onChange();
                },
            });
        });
    }

    function placementForMenu(wrap, menu) {
        const rect = wrap.getBoundingClientRect();
        const menuHeight = Math.min(menu.scrollHeight || 220, 220);
        const spaceAbove = rect.top;
        const spaceBelow = global.innerHeight - rect.bottom;
        const openUp = spaceAbove >= menuHeight + 8 || spaceAbove > spaceBelow;
        menu.classList.toggle('pullup-open-up', openUp);
        menu.classList.toggle('pullup-open-down', !openUp);
        menu.style.position = 'fixed';
        menu.style.left = `${Math.max(8, rect.left)}px`;
        menu.style.width = `${rect.width}px`;
        menu.style.right = 'auto';
        menu.style.zIndex = '100000';
        if (openUp) {
            menu.style.bottom = `${Math.max(8, global.innerHeight - rect.top + 4)}px`;
            menu.style.top = 'auto';
        } else {
            menu.style.top = `${Math.min(global.innerHeight - 8, rect.bottom + 4)}px`;
            menu.style.bottom = 'auto';
        }
        return openUp ? 'up' : 'down';
    }

    function resetMenuPosition(menu) {
        menu.style.position = '';
        menu.style.left = '';
        menu.style.right = '';
        menu.style.top = '';
        menu.style.bottom = '';
        menu.style.width = '';
        menu.style.zIndex = '';
    }

    function buildMenuItems(select, menu, state) {
        menu.innerHTML = '';
        const options = [...select.options];
        if (!options.length) {
            menu.innerHTML = `<div class="pullup-select-empty">${escapeHtml('—')}</div>`;
            return;
        }

        function appendOption(option) {
            const index = option.index;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'pullup-select-item';
            btn.setAttribute('role', 'option');
            btn.dataset.index = String(index);
            btn.dataset.value = option.value;
            if (option.disabled) {
                btn.disabled = true;
                btn.classList.add('is-disabled');
            }
            if (index === select.selectedIndex) {
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
            } else {
                btn.setAttribute('aria-selected', 'false');
            }
            btn.innerHTML = `<span class="pullup-select-item-label">${escapeHtml(optionLabel(option, select))}</span>`;
            btn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (option.disabled) return;
                chooseOption(select, state, index);
            });
            menu.appendChild(btn);
        }

        [...select.childNodes].forEach((node) => {
            if (node.nodeType !== 1) return;
            if (node.tagName === 'OPTGROUP') {
                const head = document.createElement('div');
                head.className = 'pullup-select-group';
                head.textContent = node.label || node.getAttribute('label') || '';
                menu.appendChild(head);
                [...node.querySelectorAll('option')].forEach(appendOption);
                return;
            }
            if (node.tagName === 'OPTION') appendOption(node);
        });
    }

    function updateTrigger(select, state) {
        const option = getSelectedOption(select);
        const label = optionLabel(option, select);
        state.current.textContent = label || '—';
        state.trigger.disabled = select.disabled;
        state.trigger.setAttribute('aria-disabled', select.disabled ? 'true' : 'false');
        if (state.menu && !state.menu.classList.contains('hidden')) {
            buildMenuItems(select, state.menu, state);
        }
    }

    function closeMenu(state) {
        if (!state || state.menu.classList.contains('hidden')) return;
        state.menu.classList.add('hidden');
        resetMenuPosition(state.menu);
        state.trigger.setAttribute('aria-expanded', 'false');
        openMenus.delete(state);
        state.focusIndex = -1;
    }

    function openMenu(select, state) {
        if (select.disabled) return;
        closeAll();
        buildMenuItems(select, state.menu, state);
        state.menu.classList.remove('hidden');
        state.trigger.setAttribute('aria-expanded', 'true');
        placementForMenu(state.wrap, state.menu);
        openMenus.add(state);
        const active = state.menu.querySelector('.pullup-select-item.active:not(.is-disabled)');
        state.focusIndex = active ? Number(active.dataset.index) : 0;
        focusMenuItem(state, state.focusIndex);
    }

    function focusMenuItem(state, index) {
        const items = [...state.menu.querySelectorAll('.pullup-select-item:not(.is-disabled)')];
        if (!items.length) return;
        const target = items.find((el) => Number(el.dataset.index) === index) || items[0];
        state.focusIndex = Number(target.dataset.index);
        items.forEach((el) => el.classList.toggle('is-focused', el === target));
        target.focus({ preventScroll: true });
    }

    function chooseOption(select, state, index) {
        const option = select.options[index];
        if (!option || option.disabled) return;
        if (select.selectedIndex !== index) {
            select.selectedIndex = index;
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        updateTrigger(select, state);
        closeMenu(state);
        state.trigger.focus({ preventScroll: true });
    }

    function moveFocus(state, delta) {
        const items = [...state.menu.querySelectorAll('.pullup-select-item:not(.is-disabled)')];
        if (!items.length) return;
        const currentIdx = items.findIndex((el) => Number(el.dataset.index) === state.focusIndex);
        const next = items[(currentIdx + delta + items.length) % items.length];
        focusMenuItem(state, Number(next.dataset.index));
    }

    function enhance(select, options = {}) {
        if (!select || select.tagName !== 'SELECT') return null;
        if (select.closest('.pullup-select-wrap') || select.dataset.pullupSkip !== undefined) return null;
        if (select.classList.contains('pullup-select-native')) return null;

        const wrap = document.createElement('div');
        wrap.className = 'pullup-select-wrap';
        if (options.compact) wrap.classList.add('pullup-select-wrap--compact');
        if (select.classList.contains('select-lite')) wrap.classList.add('pullup-select-wrap--lite');
        if (select.classList.contains('small-select')) wrap.classList.add('pullup-select-wrap--small');
        if (select.classList.contains('provider-select')) wrap.classList.add('pullup-select-wrap--provider');
        select.parentNode.insertBefore(wrap, select);
        wrap.appendChild(select);

        select.classList.add('pullup-select-native');
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');

        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'pullup-select-trigger';
        trigger.setAttribute('role', 'combobox');
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        const current = document.createElement('span');
        current.className = 'pullup-select-current';
        const chevron = document.createElement('span');
        chevron.className = 'pullup-select-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        chevron.innerHTML =
            '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
        trigger.appendChild(current);
        trigger.appendChild(chevron);

        const menu = document.createElement('div');
        menu.className = 'pullup-select-menu hidden';
        menu.setAttribute('role', 'listbox');
        const menuId = `pullup-menu-${Math.random().toString(36).slice(2, 9)}`;
        menu.id = menuId;
        trigger.setAttribute('aria-controls', menuId);

        wrap.appendChild(trigger);
        wrap.appendChild(menu);

        const state = { wrap, select, trigger, current, menu, focusIndex: -1 };

        hookSelectValue(select, () => updateTrigger(select, state));
        updateTrigger(select, state);

        trigger.addEventListener('mousedown', (e) => e.stopPropagation());
        menu.addEventListener('mousedown', (e) => e.stopPropagation());
        trigger.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (menu.classList.contains('hidden')) openMenu(select, state);
            else closeMenu(state);
        });

        trigger.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (menu.classList.contains('hidden')) openMenu(select, state);
                else if (e.key === 'ArrowDown') moveFocus(state, 1);
                else if (e.key === 'ArrowUp') moveFocus(state, -1);
                else if (e.key === 'Enter' || e.key === ' ') {
                    chooseOption(select, state, state.focusIndex);
                }
            } else if (e.key === 'Escape') {
                closeMenu(state);
            }
        });

        menu.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                moveFocus(state, 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                moveFocus(state, -1);
            } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                chooseOption(select, state, state.focusIndex);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeMenu(state);
                trigger.focus({ preventScroll: true });
            } else if (e.key === 'Tab') {
                closeMenu(state);
            }
        });

        select.addEventListener('change', () => updateTrigger(select, state));

        const observer = new MutationObserver(() => {
            updateTrigger(select, state);
            if (!menu.classList.contains('hidden')) buildMenuItems(select, menu, state);
        });
        observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
        state.observer = observer;
        select._pullupState = state;
        return state;
    }

    function refresh(select) {
        const state = select?._pullupState;
        if (!state) return enhance(select);
        updateTrigger(select, state);
    }

    function destroy(select) {
        const state = select?._pullupState;
        if (!state) return;
        closeMenu(state);
        state.observer?.disconnect();
        select.classList.remove('pullup-select-native');
        select.removeAttribute('aria-hidden');
        select.tabIndex = 0;
        delete select._pullupValueHooked;
        delete select._pullupState;
        state.wrap.parentNode.insertBefore(select, state.wrap);
        state.wrap.remove();
    }

    function enhanceAll(root = document, selector = DEFAULT_SELECTOR) {
        const scope = root && root.querySelectorAll ? root : document;
        scope.querySelectorAll(selector).forEach((el) => {
            if (el.matches(SKIP_SELECTOR)) return;
            if (el.closest('.pullup-select-wrap')) return;
            enhance(el);
        });
    }

    function observe(root = document.body, selector = DEFAULT_SELECTOR) {
        if (!root || root._pullupObserver) return root._pullupObserver;
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType !== 1) return;
                    if (node.matches?.(selector) && !node.matches(SKIP_SELECTOR)) enhance(node);
                    node.querySelectorAll?.(selector).forEach((el) => {
                        if (el.matches(SKIP_SELECTOR)) return;
                        if (el.closest('.pullup-select-wrap')) return;
                        enhance(el);
                    });
                });
            });
        });
        observer.observe(root, { childList: true, subtree: true });
        root._pullupObserver = observer;
        return observer;
    }

    function closeAll() {
        [...openMenus].forEach((state) => closeMenu(state));
    }

    document.addEventListener('click', (e) => {
        if (e.target.closest('.pullup-select-wrap')) return;
        closeAll();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAll();
    });

    global.addEventListener('resize', closeAll);
    global.addEventListener(
        'scroll',
        (e) => {
            if (e.target?.closest?.('.pullup-select-menu')) return;
            closeAll();
        },
        true
    );

    global.StudioPullupSelect = {
        enhance,
        refresh,
        destroy,
        enhanceAll,
        observe,
        closeAll,
        DEFAULT_SELECTOR,
    };

    function boot() {
        enhanceAll(document);
        observe(document.body);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(window);
