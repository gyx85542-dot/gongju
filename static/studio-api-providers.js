(function (global) {
    'use strict';

    var CHANNEL = 'studio-api';
    var listeners = new Set();
    var channelReady = false;

    function tr(key, fallback) {
        try {
            return global.StudioI18n ? global.StudioI18n.t(key) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function initChannel() {
        if (channelReady) return;
        channelReady = true;
        try {
            var ch = new BroadcastChannel(CHANNEL);
            ch.onmessage = function (e) {
                if (e.data && e.data.type === 'providers-changed') {
                    dispatchProvidersChanged(e.data);
                }
            };
        } catch (e) { /* ignore */ }
        global.addEventListener('message', function (e) {
            if (e.data && e.data.type === 'providers-changed') {
                dispatchProvidersChanged(e.data);
            }
        });
    }

    function dispatchProvidersChanged(payload) {
        listeners.forEach(function (fn) {
            try { fn(payload || { type: 'providers-changed' }); } catch (err) { /* ignore */ }
        });
    }

    function onProvidersChanged(fn) {
        initChannel();
        listeners.add(fn);
        return function () { listeners.delete(fn); };
    }

    function notifyProvidersChanged(extra) {
        var payload = Object.assign({ type: 'providers-changed' }, extra || {});
        try { new BroadcastChannel(CHANNEL).postMessage(payload); } catch (e) { /* ignore */ }
        try {
            if (global.parent && global.parent !== global) {
                global.parent.postMessage(payload, '*');
            }
        } catch (e) { /* ignore */ }
    }

    function fetchProviderList() {
        return fetch('/api/providers')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                return Array.isArray(data.providers) ? data.providers : [];
            })
            .catch(function () { return []; });
    }

    function enabledProviders(providers) {
        return (providers || []).filter(function (p) {
            return p && p.enabled !== false && String(p.id || '').trim();
        });
    }

    function resolveProviderId(currentId, providers, options) {
        var list = enabledProviders(providers);
        if (!list.length) return '';
        if (list.some(function (p) { return p.id === currentId; })) return currentId;
        if (options && options.deletedId === currentId) {
            /* fall through */
        }
        var primary = list.find(function (p) { return p.primary; });
        if (primary) return primary.id;
        if (options && options.preferApimart !== false) {
            var apimart = list.find(function (p) { return p.id === 'apimart'; });
            if (apimart) return apimart.id;
        }
        return list[0].id;
    }

    function providerHasKey(item) {
        return !!(item && item.has_key);
    }

    function dropdownLabel(item) {
        if (global.StudioProviderLabel && typeof global.StudioProviderLabel.dropdownLabel === 'function') {
            return global.StudioProviderLabel.dropdownLabel(item);
        }
        var name = global.StudioProviderLabel
            ? global.StudioProviderLabel.displayName(item)
            : String(item && (item.name || item.id) || '');
        if (!providerHasKey(item)) {
            var suffix = tr('provider.noKeySuffix', '（未配置Key）');
            return name + suffix;
        }
        return name;
    }

    function buildProviderOptionsHtml(providers, selectedId, escapeHtml) {
        var esc = escapeHtml || function (s) { return String(s || ''); };
        return enabledProviders(providers).map(function (p) {
            var label = dropdownLabel(p);
            var noKey = !providerHasKey(p);
            var selected = p.id === selectedId ? ' selected' : '';
            var attrs = noKey ? ' data-no-key="1"' : '';
            return '<option value="' + esc(p.id) + '"' + selected + attrs + '>' + esc(label) + '</option>';
        }).join('');
    }

    function promptMissingKey(provider) {
        var name = global.StudioProviderLabel
            ? global.StudioProviderLabel.displayName(provider)
            : String(provider && (provider.name || provider.id) || '');
        var msg = tr('provider.noKeyPrompt', '「' + name + '」尚未配置 API Key，请前往 API Settings 填写后再使用。');
        alert(msg);
    }

    function guardProviderKey(providerId, providers) {
        var item = (providers || []).find(function (p) { return p.id === providerId; });
        if (item && !providerHasKey(item)) {
            promptMissingKey(item);
            return false;
        }
        return true;
    }

    global.StudioApiProviders = {
        onProvidersChanged: onProvidersChanged,
        notifyProvidersChanged: notifyProvidersChanged,
        fetchProviderList: fetchProviderList,
        enabledProviders: enabledProviders,
        resolveProviderId: resolveProviderId,
        providerHasKey: providerHasKey,
        dropdownLabel: dropdownLabel,
        buildProviderOptionsHtml: buildProviderOptionsHtml,
        promptMissingKey: promptMissingKey,
        guardProviderKey: guardProviderKey,
    };
})(window);
