/**
 * Stable history keys + pin/favorite/folder meta helpers (survives refresh / float drift).
 */
(function (global) {
    'use strict';

    const UNCATEGORIZED_ID = '__none__';
    const ACTIVE_FOLDER_KEY = 'studio_active_folder';

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

    function normalizeFolderId(raw) {
        const id = String(raw || '').trim();
        if (!id) return '';
        if (id === UNCATEGORIZED_ID) return id;
        if (/^fld_[a-zA-Z0-9]{6,32}$/.test(id)) return id;
        return '';
    }

    function normalizeFolders(raw) {
        if (!Array.isArray(raw)) return [];
        const seen = new Set();
        const out = [];
        raw.forEach((item) => {
            if (!item || typeof item !== 'object') return;
            const id = normalizeFolderId(item.id);
            const name = String(item.name || '').trim().slice(0, 80);
            if (!id || !name || id === UNCATEGORIZED_ID || seen.has(id)) return;
            seen.add(id);
            const created = Number(item.created_at);
            out.push({
                id,
                name,
                created_at: Number.isFinite(created) ? created : Date.now() / 1000,
            });
        });
        return out;
    }

    function normalizeItemFolders(raw, folders) {
        const valid = new Set((folders || []).map((f) => f.id));
        const out = {};
        if (!raw || typeof raw !== 'object') return out;
        Object.keys(raw).forEach((key) => {
            const itemKey = normalizeTimestampKey(key);
            const folderId = normalizeFolderId(raw[key]);
            if (!itemKey || !folderId || folderId === UNCATEGORIZED_ID || !valid.has(folderId)) return;
            out[itemKey] = folderId;
        });
        return out;
    }

    function createFolderId() {
        const rand = Math.random().toString(36).slice(2, 10);
        return `fld_${rand}`;
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
        const hiddenIds = reconcileIdList(state.hiddenIds, allHistory);
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
        const missingNew = [];
        allHistory.forEach((item) => {
            const k = historyKey(item);
            if (!k || pinSet.has(k) || restSeen.has(k)) return;
            restSeen.add(k);
            missingNew.push(k);
        });
        restList = [...missingNew, ...restList];
        displayOrder = [...pinnedList, ...restList];
        return { pinnedIds, favoriteIds, hiddenIds, displayOrder };
    }

    const saveTimers = {};
    function saveUserMeta(scope, meta, delayMs) {
        const folders = normalizeFolders(meta.folders);
        const payload = {
            scope: scope || 'studio',
            pinned: normalizeIdList(meta.pinnedIds),
            favorites: normalizeIdList(meta.favoriteIds),
            hidden: normalizeIdList(meta.hiddenIds),
            order: normalizeIdList(meta.displayOrder),
            folders,
            itemFolders: normalizeItemFolders(meta.itemFolders, folders),
            activeFolderId: normalizeFolderId(meta.activeFolderId),
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
            const folders = normalizeFolders(data.folders);
            return {
                pinnedIds: normalizeIdList(data.pinned),
                favoriteIds: normalizeIdList(data.favorites),
                hiddenIds: normalizeIdList(data.hidden),
                displayOrder: normalizeIdList(data.order),
                folders,
                itemFolders: normalizeItemFolders(data.itemFolders, folders),
                activeFolderId: normalizeFolderId(data.activeFolderId),
            };
        } catch (e) {
            return {
                pinnedIds: [],
                favoriteIds: [],
                hiddenIds: [],
                displayOrder: [],
                folders: [],
                itemFolders: {},
                activeFolderId: '',
            };
        }
    }

    /** Merge server meta over localStorage (union), preferring server order when present. */
    function mergeMetaSources(local, remote) {
        const mergeList = (a, b) => normalizeIdList([...(b || []), ...(a || [])]);
        const remoteOrder = normalizeIdList(remote.displayOrder);
        const localOrder = normalizeIdList(local.displayOrder);
        const foldersMap = new Map();
        [...(local.folders || []), ...(remote.folders || [])].forEach((f) => {
            if (f?.id) foldersMap.set(f.id, f);
        });
        const folders = normalizeFolders([...foldersMap.values()]);
        const itemFolders = {
            ...normalizeItemFolders(local.itemFolders, folders),
            ...normalizeItemFolders(remote.itemFolders, folders),
        };
        let activeFolderId = normalizeFolderId(remote.activeFolderId);
        if (!activeFolderId && activeFolderId !== UNCATEGORIZED_ID) {
            activeFolderId = normalizeFolderId(local.activeFolderId);
        }
        if (activeFolderId && activeFolderId !== UNCATEGORIZED_ID && !folders.some((f) => f.id === activeFolderId)) {
            activeFolderId = '';
        }
        return {
            pinnedIds: mergeList(local.pinnedIds, remote.pinnedIds),
            favoriteIds: mergeList(local.favoriteIds, remote.favoriteIds),
            hiddenIds: mergeList(local.hiddenIds, remote.hiddenIds),
            displayOrder: remoteOrder.length ? remoteOrder : localOrder,
            folders,
            itemFolders,
            activeFolderId,
        };
    }

    function readLocalActiveFolder() {
        try {
            return normalizeFolderId(localStorage.getItem(ACTIVE_FOLDER_KEY) || '');
        } catch (e) {
            return '';
        }
    }

    function writeLocalActiveFolder(folderId) {
        try {
            localStorage.setItem(ACTIVE_FOLDER_KEY, normalizeFolderId(folderId));
        } catch (e) {}
    }

    function itemFolderId(itemFolders, key) {
        const k = normalizeTimestampKey(key);
        if (!k) return '';
        const map = itemFolders || {};
        if (map[k]) return normalizeFolderId(map[k]);
        const hit = Object.keys(map).find((id) => keysEqual(id, k));
        return hit ? normalizeFolderId(map[hit]) : '';
    }

    function matchesFolderFilter(itemFolders, key, activeFolderId) {
        const active = normalizeFolderId(activeFolderId);
        if (!active) return true; // 全部
        const current = itemFolderId(itemFolders, key);
        if (active === UNCATEGORIZED_ID) return !current;
        return current === active;
    }

    /** Map history record type → studio shell panel id (online / local / video / runninghub). */
    function studioPageForHistoryType(type) {
        const t = String(type || '').trim().toLowerCase();
        if (t === 'runninghub') return 'runninghub';
        if (t === 'local-comfy') return 'local';
        if (t === 'online-video' || t === 'online-audio') return 'video';
        return 'online';
    }

    global.StudioHistoryMeta = {
        UNCATEGORIZED_ID,
        ACTIVE_FOLDER_KEY,
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
        normalizeFolderId,
        normalizeFolders,
        normalizeItemFolders,
        createFolderId,
        readLocalActiveFolder,
        writeLocalActiveFolder,
        itemFolderId,
        matchesFolderFilter,
    };
})(typeof window !== 'undefined' ? window : globalThis);
