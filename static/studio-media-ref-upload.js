(function(global){
'use strict';

const DEFAULT_MAX = 3;
const GALLERY_VIDEO_MIME = 'application/x-studio-gallery-video';
const GALLERY_AUDIO_MIME = 'application/x-studio-gallery-audio';

function galleryMimeForKind(kind){
    return kind === 'audio' ? GALLERY_AUDIO_MIME : GALLERY_VIDEO_MIME;
}
function escapeHtml(s){
    return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function normalizeMediaUrl(url){
    const raw = String(url || '').trim();
    if(!raw) return '';
    try {
        if(/^https?:\/\//i.test(raw)){
            const parsed = new URL(raw);
            if(parsed.pathname.startsWith('/assets/') || parsed.pathname.startsWith('/output/')) return parsed.pathname;
        }
    } catch(e){}
    if(raw.startsWith('/assets/') || raw.startsWith('/output/')) return raw.split('?')[0];
    return raw;
}
function mediaUrlFromDrop(dataTransfer, kind){
    if(!dataTransfer) return '';
    const mime = galleryMimeForKind(kind);
    const typed = dataTransfer.getData(mime);
    if(typed) return normalizeMediaUrl(typed);
    const custom = dataTransfer.getData('application/x-online-output-image');
    if(custom) return normalizeMediaUrl(custom);
    const values = [
        dataTransfer.getData('text/uri-list') || '',
        dataTransfer.getData('text/plain') || ''
    ].join('\n').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for(const value of values){
        const normalized = normalizeMediaUrl(value);
        if(normalized.startsWith('/assets/') || normalized.startsWith('/output/') || /^https?:\/\//i.test(normalized)) return normalized;
    }
    return '';
}
function hasDropData(dataTransfer, acceptPrefix, kind){
    if(!dataTransfer) return false;
    const types = [...(dataTransfer.types || [])];
    if(types.includes(galleryMimeForKind(kind))) return true;
    if(types.includes('Files') && [...(dataTransfer.items || [])].some(item => item.kind === 'file' && item.type.startsWith(acceptPrefix))) return true;
    return false;
}

function createMediaRefGrid(config){
    const gridId = config.gridId;
    const kind = config.kind || 'video';
    const accept = config.accept || (kind === 'audio' ? 'audio/*' : 'video/*');
    const acceptPrefix = kind === 'audio' ? 'audio/' : 'video/';
    const maxSlots = config.maxSlots || DEFAULT_MAX;
    const tr = config.tr || (k => k);
    const onGalleryDrop = typeof config.onGalleryDrop === 'function' ? config.onGalleryDrop : null;
    const onUrlsChange = typeof config.onUrlsChange === 'function' ? config.onUrlsChange : null;
    let slots = [{ id: uid(), url: '' }];

    function uid(){
        return `mref_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    }
    function gridEl(){
        return document.getElementById(gridId);
    }
    function filledCount(){
        return slots.filter(s => s.url).length;
    }
    function ensureTrailingEmpty(){
        if(slots.filter(s => !s.url).length) return;
        if(filledCount() < maxSlots) slots.push({ id: uid(), url: '' });
    }
    function renderSlot(slot){
        const filled = !!slot.url;
        const name = filled ? (slot.name || slot.url.split('/').pop() || kind) : '';
        if(kind === 'video'){
            return `<div class="upload-item group aspect-square rounded-md flex flex-col items-center justify-center cursor-pointer${filled ? ' has-image has-media' : ''}" data-mref-id="${escapeHtml(slot.id)}">
                <input type="file" accept="${escapeHtml(accept)}" class="hidden">
                ${filled ? '' : '<i data-lucide="plus" class="w-5 h-5 text-[#737373] group-hover:text-[#ff4d94]"></i>'}
                ${filled ? `<video class="preview-img" src="${escapeHtml(slot.url)}" muted loop playsinline draggable="false"></video>` : '<video class="preview-img hidden" draggable="false"></video>'}
                <button type="button" data-mref-del class="cell-action-btn ref-slot-btn ref-del-btn" title="${escapeHtml(tr('online.delete') || 'Delete')}"><i data-lucide="trash-2"></i></button>
            </div>`;
        }
        return `<div class="upload-item group aspect-square rounded-md flex flex-col items-center justify-center cursor-pointer${filled ? ' has-image has-media' : ''}" data-mref-id="${escapeHtml(slot.id)}">
            <input type="file" accept="${escapeHtml(accept)}" class="hidden">
            ${filled ? '' : '<i data-lucide="plus" class="w-5 h-5 text-[#737373] group-hover:text-[#ff4d94]"></i>'}
            <div class="preview-media-audio${filled ? '' : ' hidden'}">
                <i data-lucide="music-2" class="w-6 h-6 text-[#ff4d94]"></i>
                <span class="preview-media-name">${escapeHtml(name)}</span>
            </div>
            <button type="button" data-mref-del class="cell-action-btn ref-slot-btn ref-del-btn" title="${escapeHtml(tr('online.delete') || 'Delete')}"><i data-lucide="trash-2"></i></button>
        </div>`;
    }
    async function uploadFile(file){
        const form = new FormData();
        form.append('files', file);
        const data = await fetch('/api/ai/upload', { method:'POST', body: form }).then(async r => {
            if(!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Upload failed');
            return r.json();
        });
        return data.files?.[0] || null;
    }
    function hasUrl(normalized){
        return slots.some(s => s.url && normalizeMediaUrl(s.url) === normalized);
    }
    function notifyUrlsChange(){
        if(onUrlsChange) onUrlsChange(getUrls());
    }
    function notifyGalleryDrop(ok){
        if(onGalleryDrop) onGalleryDrop(!!ok);
    }
    function ingestGalleryUrl(url, slotId){
        const normalized = normalizeMediaUrl(url);
        if(!normalized) return false;
        if(hasUrl(normalized)) return true;
        if(slotId){
            const slot = slots.find(s => s.id === slotId);
            if(slot && !slot.url){
                assignUrl(normalized, slotId);
                return true;
            }
        }
        return addUrl(normalized);
    }
    function isGalleryDrag(types){
        return types.includes(galleryMimeForKind(kind));
    }
    async function assignUrl(url, slotId, name){
        const normalized = normalizeMediaUrl(url);
        if(!normalized || hasUrl(normalized)) return;
        let slot = slots.find(s => s.id === slotId);
        if(!slot){
            if(filledCount() >= maxSlots) return;
            slot = { id: uid(), url: '' };
            slots.push(slot);
        }
        if(slot.url && filledCount() >= maxSlots) return;
        if(slot.url && filledCount() < maxSlots){
            const idx = slots.indexOf(slot);
            slot = { id: uid(), url: '' };
            slots.splice(idx + 1, 0, slot);
        }
        slot.url = normalized;
        slot.name = name || normalized.split('/').pop() || kind;
        ensureTrailingEmpty();
        render();
    }
    async function handleFile(file, slotId){
        if(!file) return;
        const slot = slots.find(s => s.id === slotId);
        if(!slot) return;
        if(kind === 'video'){
            const blobUrl = URL.createObjectURL(file);
            slot.url = blobUrl;
            slot.name = file.name;
            render();
        }
        try {
            const uploaded = await uploadFile(file);
            if(uploaded?.url){
                if(kind === 'video' && slot.url?.startsWith('blob:')) URL.revokeObjectURL(slot.url);
                slot.url = uploaded.url;
                slot.name = uploaded.name || file.name;
                ensureTrailingEmpty();
                render();
            }
        } catch(err){
            if(kind === 'video' && slot.url?.startsWith('blob:')){
                slot.url = '';
                slot.name = '';
                render();
            }
            alert(err.message || 'Upload failed');
        }
    }
    function removeSlot(slotId, ev){
        if(ev){ ev.preventDefault(); ev.stopPropagation(); }
        slots = slots.filter(s => s.id !== slotId);
        if(!slots.length) slots = [{ id: uid(), url: '' }];
        ensureTrailingEmpty();
        render();
    }
    function bindEvents(cell, slot){
        const input = cell.querySelector('input[type="file"]');
        const delBtn = cell.querySelector('[data-mref-del]');
        cell.onclick = e => {
            if(e.target.closest('[data-mref-del]')) return;
            if(!slot.url) input?.click();
        };
        input.onchange = () => {
            handleFile(input.files[0], slot.id);
            input.value = '';
        };
        delBtn?.addEventListener('click', e => removeSlot(slot.id, e));
        cell.ondragover = e => {
            if(!hasDropData(e.dataTransfer, acceptPrefix, kind)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            cell.classList.add('drag-over');
        };
        cell.ondragleave = e => {
            if(e.currentTarget.contains(e.relatedTarget)) return;
            cell.classList.remove('drag-over');
        };
        cell.ondrop = e => {
            e.preventDefault();
            e.stopPropagation();
            cell.classList.remove('drag-over');
            const types = [...(e.dataTransfer?.types || [])];
            const file = e.dataTransfer.files?.[0];
            if(file && file.type.startsWith(acceptPrefix)){
                handleFile(file, slot.id);
                return;
            }
            const url = mediaUrlFromDrop(e.dataTransfer, kind);
            if(!url) return;
            if(isGalleryDrag(types)){
                notifyGalleryDrop(ingestGalleryUrl(url, slot.id));
                return;
            }
            assignUrl(url, slot.id);
        };
    }
    function bindDropZone(zoneEl){
        if(!zoneEl) return;
        const clearZone = () => zoneEl.classList.remove('drag-over', 'drop-zone-active', 'drop-zone-reject');
        zoneEl.addEventListener('dragover', e => {
            if(!hasDropData(e.dataTransfer, acceptPrefix, kind)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            zoneEl.classList.add('drag-over');
        });
        zoneEl.addEventListener('dragleave', e => {
            if(zoneEl.contains(e.relatedTarget)) return;
            clearZone();
        });
        zoneEl.addEventListener('drop', e => {
            e.preventDefault();
            e.stopPropagation();
            clearZone();
            const types = [...(e.dataTransfer?.types || [])];
            const file = e.dataTransfer.files?.[0];
            if(file && file.type.startsWith(acceptPrefix)){
                const empty = slots.find(s => !s.url);
                if(empty) handleFile(file, empty.id);
                return;
            }
            const url = mediaUrlFromDrop(e.dataTransfer, kind);
            if(!url) return;
            if(isGalleryDrag(types)){
                clearZone();
                notifyGalleryDrop(ingestGalleryUrl(url));
                return;
            }
            addUrl(url);
        });
    }
    function addUrl(url, name){
        const normalized = normalizeMediaUrl(url);
        if(!normalized) return false;
        if(hasUrl(normalized)) return true;
        if(filledCount() >= maxSlots) return false;
        const empty = slots.find(s => !s.url);
        if(!empty){
            ensureTrailingEmpty();
            const next = slots.find(s => !s.url);
            if(!next) return false;
            assignUrl(normalized, next.id, name);
            return true;
        }
        assignUrl(normalized, empty.id, name);
        return true;
    }
    function render(){
        const grid = gridEl();
        if(!grid) return;
        ensureTrailingEmpty();
        grid.innerHTML = slots.map(renderSlot).join('');
        slots.forEach(slot => {
            const cell = grid.querySelector(`[data-mref-id="${slot.id}"]`);
            if(cell) bindEvents(cell, slot);
        });
        if(global.lucide) global.lucide.createIcons();
        notifyUrlsChange();
    }
    function getUrls(){
        return slots.map(s => s.url).filter(Boolean).map(normalizeMediaUrl).filter(Boolean);
    }
    function setUrls(urls){
        const seen = new Set();
        const list = (urls || []).slice(0, maxSlots).filter(Boolean).filter(url => {
            const normalized = normalizeMediaUrl(url);
            if(!normalized || seen.has(normalized)) return false;
            seen.add(normalized);
            return true;
        });
        slots = list.map(url => ({ id: uid(), url: normalizeMediaUrl(url), name: String(url).split('/').pop() || kind }));
        ensureTrailingEmpty();
        render();
    }
    render();
    return { getUrls, setUrls, addUrl, render, bindDropZone, kind, gridId, dropZoneEl: null };
}

function createGalleryRelay(options = {}){
    const entries = [];
    let dropLock = '';
    let bound = false;

    function clearHighlights(){
        entries.forEach(e => {
            e.zoneEl?.classList.remove('drop-zone-active', 'drop-zone-reject', 'drag-over');
        });
    }
    function hitZone(x, y){
        for(const e of entries){
            if(!e.zoneEl || !e.zoneEl.offsetParent) continue;
            const r = e.zoneEl.getBoundingClientRect();
            if(x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return e;
        }
        return null;
    }
    function handleOver(payload){
        clearHighlights();
        if(typeof options.isEnabled === 'function' && !options.isEnabled()) return;
        const zone = hitZone(payload.x, payload.y);
        if(!zone) return;
        if(payload.mediaKind === zone.kind){
            zone.zoneEl.classList.add('drop-zone-active');
        } else {
            zone.zoneEl.classList.add('drop-zone-reject');
        }
    }
    function handleDrop(payload){
        if(typeof options.isEnabled === 'function' && !options.isEnabled()){
            options.onDropRejected?.();
            return;
        }
        if(!payload?.url){
            options.onDropRejected?.();
            return;
        }
        const sig = `${payload.mediaKind}|${payload.url}`;
        if(dropLock === sig) return;
        dropLock = sig;
        setTimeout(() => { if(dropLock === sig) dropLock = ''; }, 400);
        clearHighlights();
        const zone = hitZone(payload.x, payload.y);
        if(!zone || payload.mediaKind !== zone.kind){
            if(zone){
                zone.zoneEl.classList.add('drop-zone-reject');
                setTimeout(() => zone.zoneEl.classList.remove('drop-zone-reject'), 400);
            }
            options.onDropRejected?.();
            return;
        }
        const ok = zone.instance.addUrl(payload.url);
        clearHighlights();
        if(ok) options.onDropAccepted?.();
        else options.onDropRejected?.();
    }

    const relay = {
        register(entry){ entries.push(entry); },
        clearHighlights,
        bind(){
            if(bound) return;
            bound = true;
            window.addEventListener('message', e => {
                const data = e.data || {};
                if(data.type === 'studio-gallery-drag-over') handleOver(data);
                if(data.type === 'studio-gallery-drag-drop') handleDrop(data);
                if(data.type === 'studio-gallery-drag-end') clearHighlights();
            });
        },
        _options: options
    };
    return relay;
}

function mount(config = {}){
    const dropZoneId = config.dropZoneId || `${config.gridId}DropZone`;
    const dropZoneEl = config.dropZoneEl || document.getElementById(dropZoneId);
    const relay = config.galleryRelay;
    const onGalleryDrop = config.onGalleryDrop || (relay ? ok => {
        relay.clearHighlights();
        if(ok) relay._options?.onDropAccepted?.();
    } : null);
    const instance = createMediaRefGrid({ ...config, onGalleryDrop });
    if(dropZoneEl){
        instance.bindDropZone(dropZoneEl);
        instance.dropZoneEl = dropZoneEl;
    }
    if(relay && dropZoneEl){
        relay.register({ zoneEl: dropZoneEl, kind: config.kind, instance });
    }
    return instance;
}

function mountSection(config = {}){
    const host = typeof config.container === 'string' ? document.getElementById(config.container) : config.container;
    if(!host || !config.gridId) return null;
    const gridId = config.gridId;
    const dropZoneId = config.dropZoneId || `${gridId}DropZone`;
    const kind = config.kind || 'video';
    const label = config.label || '';
    const labelKey = config.labelKey || '';
    const block = document.createElement('div');
    block.className = config.sectionClass || 'media-ref-block';
    const labelHtml = labelKey
        ? `<span data-i18n="${escapeHtml(labelKey)}">${escapeHtml(label)}</span>`
        : escapeHtml(label);
    block.innerHTML = `<div class="control-label mb-1">${labelHtml}</div>
        <div id="${escapeHtml(dropZoneId)}" class="media-ref-drop-zone" data-media-kind="${escapeHtml(kind)}">
            <div id="${escapeHtml(gridId)}" class="ref-grid"></div>
        </div>`;
    host.appendChild(block);
    if(global.lucide) global.lucide.createIcons();
    return mount({ ...config, gridId, dropZoneId, kind });
}

function setCollapsible(wrapId, open, relay){
    const wrap = typeof wrapId === 'string' ? document.getElementById(wrapId) : wrapId;
    if(!wrap) return;
    wrap.classList.toggle('is-open', !!open);
    wrap.setAttribute('aria-hidden', open ? 'false' : 'true');
    if(!open && relay) relay.clearHighlights();
}

const StudioMediaRefUpload = {
    VIDEO_MIME: GALLERY_VIDEO_MIME,
    AUDIO_MIME: GALLERY_AUDIO_MIME,
    normalizeUrl: normalizeMediaUrl,
    createGalleryRelay,
    mount,
    mountSection,
    setCollapsible,
    create: mount
};

global.StudioMediaRefUpload = StudioMediaRefUpload;
})(window);
