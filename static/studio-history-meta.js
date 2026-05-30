/**

 * Stable history keys + pin/favorite meta helpers (survives refresh / float drift).

 */

(function (global) {

    'use strict';



    /** Unix seconds (~1e9) vs milliseconds (~1e12); never multiply ms keys again. */

    function normalizeTimestampKey(ts) {

        if (ts == null || ts === '') return '';

        const raw = String(ts).trim();

        if (!raw || raw === 'Infinity' || raw === '-Infinity' || raw === 'NaN') return '';

        if (/e[+-]/i.test(raw)) return '';

        const n = Number(raw);

        if (!Number.isFinite(n)) return '';

        if (n >= 1e12) return String(Math.round(n));

        if (n >= 1e9) return String(Math.round(n * 1000));

        return '';

    }



    function keysEqual(a, b) {

        if (a == null || b == null || a === '' || b === '') return false;

        return normalizeTimestampKey(a) === normalizeTimestampKey(b);

    }



    function historyKey(item) {

        return normalizeTimestampKey(item?.timestamp);

    }



    function isValidMetaKey(key) {

        const k = normalizeTimestampKey(key);

        return !!k && /^\d{10,16}$/.test(k);

    }



    function normalizeIdList(raw) {

        if (!Array.isArray(raw)) {

            if (raw == null || raw === '') return [];

            const key = normalizeTimestampKey(raw);

            return key ? [key] : [];

        }

        const seen = new Set();

        const out = [];

        raw.forEach((id) => {

            const key = normalizeTimestampKey(id);

            if (!key || seen.has(key)) return;

            seen.add(key);

            out.push(key);

        });

        return out;

    }



    function includesKey(list, key) {

        const nk = normalizeTimestampKey(key);

        if (!nk) return false;

        return (list || []).some((id) => keysEqual(id, nk));

    }



    function findHistoryItem(historyList, key) {

        return (historyList || []).find((item) => keysEqual(item?.timestamp, key)) || null;

    }



    /** Map stored ids to canonical keys; drop entries with no matching history item. */

    function reconcileIdList(storedIds, historyList, { requireHistory = true } = {}) {

        const seen = new Set();

        const out = [];

        (storedIds || []).forEach((id) => {

            if (!isValidMetaKey(id)) return;

            const hit = findHistoryItem(historyList, id);

            const canonical = hit ? historyKey(hit) : normalizeTimestampKey(id);

            if (!canonical || seen.has(canonical)) return;

            if (requireHistory && historyList?.length && !hit) return;

            seen.add(canonical);

            out.push(canonical);

        });

        return out;

    }



    function syncMetaState(state, historyList) {

        const allHistory = historyList || [];

        const pinnedIds = reconcileIdList(state.pinnedIds, allHistory);

        const favoriteIds = reconcileIdList(state.favoriteIds, allHistory);

        let displayOrder = reconcileIdList(state.displayOrder, allHistory, { requireHistory: false })

            .filter((id) => isValidMetaKey(id));

        const pinSet = new Set(pinnedIds);

        const pinnedList = pinnedIds.slice();

        displayOrder.filter((id) => pinSet.has(id) && !pinnedList.includes(id)).forEach((id) => pinnedList.push(id));

        const restSeen = new Set();

        let restList = [];

        displayOrder.forEach((id) => {

            if (pinSet.has(id) || restSeen.has(id)) return;

            restSeen.add(id);

            restList.push(id);

        });

        allHistory.forEach((item) => {

            const k = historyKey(item);

            if (!k || pinSet.has(k) || restSeen.has(k)) return;

            restSeen.add(k);

            restList.push(k);

        });

        displayOrder = [...pinnedList, ...restList];

        return { pinnedIds, favoriteIds, displayOrder };

    }



    const saveTimers = {};

    function saveUserMeta(scope, meta, delayMs) {

        const payload = {

            scope: scope || 'studio',

            pinned: normalizeIdList(meta.pinnedIds),

            favorites: normalizeIdList(meta.favoriteIds),

            order: normalizeIdList(meta.displayOrder),

        };

        clearTimeout(saveTimers[payload.scope]);

        saveTimers[payload.scope] = setTimeout(() => {

            fetch('/api/history/user-meta', {

                method: 'PUT',

                headers: { 'Content-Type': 'application/json' },

                body: JSON.stringify(payload),

            }).catch(() => {});

        }, delayMs == null ? 280 : delayMs);

        return payload;

    }



    async function loadUserMeta(scope) {

        try {

            const res = await fetch(`/api/history/user-meta?scope=${encodeURIComponent(scope || 'studio')}`);

            if (!res.ok) throw new Error(String(res.status));

            const data = await res.json();

            return {

                pinnedIds: normalizeIdList(data.pinned),

                favoriteIds: normalizeIdList(data.favorites),

                displayOrder: normalizeIdList(data.order),

            };

        } catch (e) {

            return { pinnedIds: [], favoriteIds: [], displayOrder: [] };

        }

    }



    /** Merge server meta over localStorage (union), preferring server order when present. */

    function mergeMetaSources(local, remote) {

        const mergeList = (a, b) => normalizeIdList([...(b || []), ...(a || [])]);

        const remoteOrder = normalizeIdList(remote.displayOrder);

        const localOrder = normalizeIdList(local.displayOrder);

        return {

            pinnedIds: mergeList(local.pinnedIds, remote.pinnedIds),

            favoriteIds: mergeList(local.favoriteIds, remote.favoriteIds),

            displayOrder: remoteOrder.length ? remoteOrder : localOrder,

        };

    }



    /** Map history record type → studio shell panel id (online / local / video / runninghub). */
    function studioPageForHistoryType(type){
        const t = String(type || '').trim().toLowerCase();
        if(t === 'runninghub') return 'runninghub';
        if(t === 'local-comfy') return 'local';
        if(t === 'online-video' || t === 'online-audio') return 'video';
        return 'online';
    }



    global.StudioHistoryMeta = {

        normalizeTimestampKey,

        keysEqual,

        historyKey,

        studioPageForHistoryType,

        isValidMetaKey,

        normalizeIdList,

        includesKey,

        findHistoryItem,

        reconcileIdList,

        syncMetaState,

        saveUserMeta,

        loadUserMeta,

        mergeMetaSources,

    };

})(typeof window !== 'undefined' ? window : globalThis);

