(function (global) {
    'use strict';

    function isApimartProvider(item) {
        const id = String(item?.id ?? item?.value ?? '').toLowerCase();
        const name = String(item?.name ?? item?.label ?? item?.text ?? '').toLowerCase();
        return id === 'apimart' || id === 'custom-api' || name === 'apimart' || name.includes('apimart');
    }

    function displayName(item) {
        if (isApimartProvider(item)) return '🐻';
        return String(item?.name ?? item?.label ?? item?.id ?? item?.value ?? '');
    }

    function noKeySuffix() {
        try {
            return window.StudioI18n ? window.StudioI18n.t('provider.noKeySuffix') : '（未配置Key）';
        } catch (e) {
            return '（未配置Key）';
        }
    }

    function dropdownLabel(item) {
        const name = displayName(item);
        if (item && item.has_key === false) {
            return `${name}${noKeySuffix()}`;
        }
        return name;
    }

    function isProviderSelect(select) {
        if (!select || select.tagName !== 'SELECT') return false;
        if (select.id === 'providerSelect') return true;
        return (
            select.classList.contains('provider-select') ||
            select.classList.contains('llm-provider-select') ||
            select.classList.contains('video-provider')
        );
    }

    function optionLabel(option, select) {
        if (!option) return '';
        const raw = option.textContent?.trim() || option.label || option.value || '';
        if (!isProviderSelect(select)) return raw;
        return raw;
    }

    global.StudioProviderLabel = {
        isApimartProvider,
        displayName,
        dropdownLabel,
        isProviderSelect,
        optionLabel,
    };
})(window);
