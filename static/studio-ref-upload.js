(function(global){
'use strict';

const MAX_REF_SLOTS = 13;
const REF_REORDER_MIME = 'application/x-online-ref-reorder';

let refSlots = [];
let refReorderDragId = '';
let boardPickSlotId = '';
let opts = {};

function tr(k){ return opts.tr ? opts.tr(k) : k; }
function escapeHtml(s){
    if(opts.escapeHtml) return opts.escapeHtml(s);
    return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function gridSelector(){
    if(opts.gridSelector) return opts.gridSelector;
    const id = opts.gridId || 'refGrid';
    return `#${id}`;
}
function gridEl(){
    if(opts.gridId) return document.getElementById(opts.gridId);
    return document.getElementById('refGrid');
}
function isFixedMode(){
    return opts.mode === 'fixed';
}

function newRefSlot(ref = null, dim = null, id = null){
    return { id: id || `ref_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ref, dim };
}
function filledRefCount(){
    return refSlots.filter(s => s.ref).length;
}
function firstEmptyRefSlot(){
    return refSlots.find(s => !s.ref)?.id || refSlots[refSlots.length - 1]?.id;
}
function ensureTrailingEmptySlot(){
    if(isFixedMode() && opts.enableTrailingEmpty === false) return;
    const hasEmpty = refSlots.some(s => !s.ref);
    if(!hasEmpty && refSlots.length < MAX_REF_SLOTS) refSlots.push(newRefSlot());
    if(!refSlots.length) refSlots.push(newRefSlot());
}
function clearRefDropHints(){
    document.querySelectorAll(`${gridSelector()} .upload-item.drop-before,${gridSelector()} .upload-item.drop-after`).forEach(el => {
        el.classList.remove('drop-before', 'drop-after');
    });
}
function normalizeImageUrl(url){
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
function imageUrlFromSlotDrop(dataTransfer){
    if(!dataTransfer) return '';
    const custom = dataTransfer.getData('application/x-online-output-image');
    if(custom) return normalizeImageUrl(custom);
    const values = [
        dataTransfer.getData('text/uri-list') || '',
        dataTransfer.getData('text/plain') || ''
    ].join('\n').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for(const value of values){
        const normalized = normalizeImageUrl(value);
        if(normalized.startsWith('/assets/') || normalized.startsWith('/output/')) return normalized;
    }
    return '';
}
function hasSlotDropData(dataTransfer){
    if(!dataTransfer) return false;
    const types = [...(dataTransfer.types || [])];
    if(types.includes('application/x-online-output-image')) return true;
    if(types.includes('Files') && [...(dataTransfer.items || [])].some(item => item.kind === 'file' && item.type.startsWith('image/'))) return true;
    return types.includes('text/uri-list') || types.includes('text/plain');
}
function setImageDragData(e, url){
    const normalized = normalizeImageUrl(url);
    if(!normalized) return;
    e.dataTransfer.setData('application/x-online-output-image', normalized);
    e.dataTransfer.setData('text/uri-list', normalized);
    e.dataTransfer.setData('text/plain', normalized);
}
function getImageDimensions(src){
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = reject;
        img.src = src;
    });
}
function notifyChange(dim){
    if(typeof opts.onChange === 'function') opts.onChange(dim || null);
}
function syncBoardPickWindow(){
    global.boardPickSlotId = boardPickSlotId;
}
function updateBoardPickUI(){
    document.body.classList.toggle('board-pick-active', !!boardPickSlotId);
    document.querySelectorAll(`${gridSelector()} .upload-item.is-board-target`).forEach(el => el.classList.remove('is-board-target'));
    if(boardPickSlotId){
        document.querySelector(`${gridSelector()} [data-ref-id="${boardPickSlotId}"]`)?.classList.add('is-board-target');
    }
    if(typeof opts.onBoardPickUI === 'function') opts.onBoardPickUI(boardPickSlotId);
}
function cancelBoardPick(){
    if(!boardPickSlotId) return;
    boardPickSlotId = '';
    syncBoardPickWindow();
    updateBoardPickUI();
    if(global.StudioPanelBridge) global.StudioPanelBridge.notifyBoardPick('');
    else if(typeof opts.onBoardPickChange === 'function') opts.onBoardPickChange('');
}
function startBoardPick(slotId, ev){
    if(ev){ ev.preventDefault(); ev.stopPropagation(); }
    if(boardPickSlotId === slotId){
        cancelBoardPick();
        return;
    }
    boardPickSlotId = slotId;
    syncBoardPickWindow();
    updateBoardPickUI();
    if(global.StudioPanelBridge) global.StudioPanelBridge.notifyBoardPick(slotId);
    else if(typeof opts.onBoardPickChange === 'function') opts.onBoardPickChange(slotId);
}
function reorderRefSlots(sourceId, targetId, placeBefore){
    if(!sourceId || !targetId || sourceId === targetId) return;
    const list = [...refSlots];
    const from = list.findIndex(s => s.id === sourceId);
    const to = list.findIndex(s => s.id === targetId);
    if(from < 0 || to < 0) return;
    const [item] = list.splice(from, 1);
    let insertAt = list.findIndex(s => s.id === targetId);
    if(insertAt < 0) insertAt = list.length;
    if(!placeBefore) insertAt += 1;
    list.splice(insertAt, 0, item);
    refSlots = list;
    if(typeof opts.onReorder === 'function') opts.onReorder(refSlots.map(s => s.id));
    renderRefGrid();
}
async function handleImageUrl(url, slotId){
    const normalized = normalizeImageUrl(url);
    if(!normalized) return;
    if(isFixedMode()){
        if(typeof opts.onUrlAssign === 'function'){
            await opts.onUrlAssign(slotId, normalized);
        }
        cancelBoardPick();
        return;
    }
    let slot = refSlots.find(s => s.id === slotId);
    if(!slot){
        if(filledRefCount() >= MAX_REF_SLOTS) return;
        slot = newRefSlot();
        refSlots.push(slot);
    }
    if(slot.ref && filledRefCount() >= MAX_REF_SLOTS) return;
    if(slot.ref && filledRefCount() < MAX_REF_SLOTS){
        const idx = refSlots.indexOf(slot);
        slot = newRefSlot();
        refSlots.splice(idx + 1, 0, slot);
    }
    slot.ref = { url: normalized, name: normalized.split('/').pop() || 'image.png', role: '' };
    try {
        slot.dim = await getImageDimensions(normalized);
    } catch(e){}
    ensureTrailingEmptySlot();
    renderRefGrid();
    notifyChange(slot.dim || null);
    cancelBoardPick();
}
async function handleFile(file, slotId){
    if(!file) return;
    if(isFixedMode()){
        if(typeof opts.onFileUpload === 'function'){
            await opts.onFileUpload(slotId, file);
        }
        return;
    }
    const slot = refSlots.find(s => s.id === slotId);
    if(!slot) return;
    const reader = new FileReader();
    reader.onload = e => {
        getImageDimensions(e.target.result).then(dim => {
            slot.dim = dim;
            renderRefGrid();
            notifyChange(dim);
        }).catch(() => renderRefGrid());
    };
    reader.readAsDataURL(file);
    const form = new FormData();
    form.append('files', file);
    const data = await fetch('/api/ai/upload', { method:'POST', body: form }).then(r => r.json());
    slot.ref = data.files[0];
    ensureTrailingEmptySlot();
    renderRefGrid();
    notifyChange(slot.dim || null);
}
function removeRefSlot(slotId, ev){
    if(ev){ ev.preventDefault(); ev.stopPropagation(); }
    if(isFixedMode()){
        const slot = refSlots.find(s => s.id === slotId);
        if(slot){ slot.ref = null; slot.dim = null; }
        if(typeof opts.onRemove === 'function') opts.onRemove(slotId);
        renderRefGrid();
        notifyChange(null);
        if(boardPickSlotId === slotId) cancelBoardPick();
        return;
    }
    refSlots = refSlots.filter(s => s.id !== slotId);
    if(!refSlots.length) refSlots = [newRefSlot()];
    ensureTrailingEmptySlot();
    renderRefGrid();
    notifyChange(null);
}
function bindRefSlotEvents(cell, slot){
    const input = cell.querySelector('input[type="file"]');
    const delBtn = cell.querySelector('[data-ref-del]');
    const handle = cell.querySelector('[data-ref-reorder]');
    const boardBtn = cell.querySelector('[data-ref-board]');
    const canReorder = !isFixedMode() || typeof opts.onReorder === 'function';
    cell.onclick = e => {
        if(e.target.closest('[data-ref-del],[data-ref-reorder],[data-ref-board]')) return;
        const hasRef = isFixedMode() ? !!slot.ref : !!slot.ref;
        if(!hasRef) input?.click();
    };
    input.onchange = () => {
        handleFile(input.files[0], slot.id);
        input.value = '';
    };
    delBtn?.addEventListener('click', e => removeRefSlot(slot.id, e));
    boardBtn?.addEventListener('click', e => startBoardPick(slot.id, e));
    cell.ondragover = e => {
        const types = [...(e.dataTransfer?.types || [])];
        if(canReorder && types.includes(REF_REORDER_MIME)){
            if(refReorderDragId && refReorderDragId !== slot.id){
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                clearRefDropHints();
                const rect = cell.getBoundingClientRect();
                cell.classList.add((e.clientX - rect.left) < rect.width / 2 ? 'drop-before' : 'drop-after');
            }
            return;
        }
        if(!hasSlotDropData(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        cell.classList.add('drag-over');
    };
    cell.ondragleave = e => {
        if(e.currentTarget.contains(e.relatedTarget)) return;
        cell.classList.remove('drag-over', 'drop-before', 'drop-after');
    };
    cell.ondrop = e => {
        e.preventDefault();
        e.stopPropagation();
        cell.classList.remove('drag-over');
        const types = [...(e.dataTransfer?.types || [])];
        if(canReorder && types.includes(REF_REORDER_MIME)){
            const dragId = refReorderDragId || e.dataTransfer.getData(REF_REORDER_MIME);
            if(dragId && dragId !== slot.id){
                const rect = cell.getBoundingClientRect();
                reorderRefSlots(dragId, slot.id, (e.clientX - rect.left) < rect.width / 2);
            }
            clearRefDropHints();
            return;
        }
        const file = e.dataTransfer.files?.[0];
        if(file && file.type.startsWith('image/')){
            handleFile(file, slot.id);
            return;
        }
        const url = imageUrlFromSlotDrop(e.dataTransfer);
        if(url) handleImageUrl(url, slot.id);
    };
    if(handle && slot.ref && canReorder){
        handle.draggable = true;
        handle.ondragstart = e => {
            e.stopPropagation();
            refReorderDragId = slot.id;
            cell.classList.add('is-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData(REF_REORDER_MIME, slot.id);
        };
        handle.ondragend = () => {
            refReorderDragId = '';
            cell.classList.remove('is-dragging');
            clearRefDropHints();
        };
    } else if(handle){
        handle.draggable = false;
    }
}
function renderSlotHtml(slot, idx){
    const filled = !!slot.ref;
    const preview = filled ? slot.ref.url : '';
    return `<div class="upload-item group aspect-square rounded-md flex flex-col items-center justify-center cursor-pointer${filled ? ' has-image' : ''}${boardPickSlotId === slot.id ? ' is-board-target' : ''}" data-ref-id="${escapeHtml(slot.id)}">
        <input type="file" accept="image/*" class="hidden">
        ${filled ? '' : '<i data-lucide="plus" class="w-5 h-5 text-[#737373] group-hover:text-[#ff4d94]"></i>'}
        <span class="ref-slot-label mt-2 uppercase">${String(idx + 1).padStart(2, '0')}</span>
        <img class="preview-img${filled ? '' : ' hidden'}" ${filled ? `src="${escapeHtml(preview)}"` : ''} draggable="false" alt="">
        <button type="button" data-ref-board class="cell-action-btn ref-slot-btn ref-board-btn" title="${escapeHtml(tr('online.boardPickTitle'))}">board</button>
        <button type="button" data-ref-reorder class="cell-action-btn ref-slot-btn ref-reorder-btn" title="${escapeHtml(tr('online.reorder') || 'Reorder')}"><i data-lucide="grip-vertical"></i></button>
        <button type="button" data-ref-del class="cell-action-btn ref-slot-btn ref-del-btn" title="${escapeHtml(tr('online.delete') || 'Delete')}"><i data-lucide="trash-2"></i></button>
    </div>`;
}
function renderRefGrid(){
    const grid = gridEl();
    if(!grid) return;
    if(!isFixedMode()) ensureTrailingEmptySlot();
    grid.innerHTML = refSlots.map((slot, idx) => renderSlotHtml(slot, idx)).join('');
    refSlots.forEach(slot => {
        const cell = grid.querySelector(`[data-ref-id="${slot.id}"]`);
        if(cell) bindRefSlotEvents(cell, slot);
    });
    if(global.lucide) global.lucide.createIcons();
    updateBoardPickUI();
}

function getReferenceList(){
    if(opts.referenceFormat === 'video'){
        return refSlots.filter(s => s.ref?.url).map(s => ({ url: s.ref.url, name: s.ref.name || '', role: s.ref.role || '' }));
    }
    return refSlots.map(s => s.ref).filter(Boolean);
}
function firstReferenceDimension(){
    return refSlots.map(s => s.dim).find(dim => dim?.width && dim?.height) || null;
}
function setReferenceImages(refs){
    refSlots = (refs || []).slice(0, MAX_REF_SLOTS).map(ref => newRefSlot(ref, null));
    ensureTrailingEmptySlot();
    renderRefGrid();
    (refs || []).forEach(ref => {
        if(!ref?.url) return;
        getImageDimensions(ref.url).then(dim => {
            const slot = refSlots.find(s => s.ref?.url === ref.url);
            if(slot) slot.dim = dim;
            notifyChange(dim);
            renderRefGrid();
        }).catch(() => {});
    });
}
function pickOutputForRef(data){
    const url = data?.images?.[0];
    if(!url || !boardPickSlotId) return;
    handleImageUrl(url, boardPickSlotId);
}
function syncFixedSlots(slots){
    refSlots = (slots || []).map(s => newRefSlot(s.ref || null, s.dim || null, s.id));
    if(boardPickSlotId && !refSlots.some(s => s.id === boardPickSlotId)){
        boardPickSlotId = '';
        syncBoardPickWindow();
    }
    renderRefGrid();
}
function mountFixed(containerOrId, slots, handlers = {}){
    Object.assign(opts, handlers, { mode: 'fixed', enableTrailingEmpty: false });
    if(typeof containerOrId === 'string'){
        opts.gridId = containerOrId.replace(/^#/, '');
    } else if(containerOrId?.id){
        opts.gridId = containerOrId.id;
    }
    syncFixedSlots(slots);
}

global.handleImageUrl = handleImageUrl;
global.cancelBoardPick = cancelBoardPick;
global.pickOutputForRef = pickOutputForRef;

global.StudioRefUpload = {
    init(options = {}){
        opts = { mode: 'dynamic', ...options };
        refSlots = options.initialSlots || [newRefSlot()];
        boardPickSlotId = '';
        syncBoardPickWindow();
        renderRefGrid();
        if(!global._studioRefUploadKeyBound){
            global._studioRefUploadKeyBound = true;
            global.addEventListener('keydown', e => {
                if(e.key === 'Escape' && boardPickSlotId) cancelBoardPick();
            });
            global.addEventListener('paste', e => {
                if(isFixedMode()) return;
                const item = [...(e.clipboardData?.items || [])].find(x => x.kind === 'file' && x.type.startsWith('image/'));
                if(item) handleFile(item.getAsFile(), firstEmptyRefSlot());
            });
        }
        if(!global._studioRefUploadClickBound){
            global._studioRefUploadClickBound = true;
            document.addEventListener('click', e => {
                if(!boardPickSlotId) return;
                if(e.target.closest('[data-ref-board]')) return;
                cancelBoardPick();
            });
        }
    },
    mountFixed,
    syncFixedSlots,
    renderRefGrid,
    renderSlotHtml,
    getReferenceList,
    setReferenceImages,
    firstReferenceDimension,
    getBoardPickSlotId(){ return boardPickSlotId; },
    pickOutputForRef,
    normalizeImageUrl,
    setImageDragData,
    cancelBoardPick,
    updateBoardPickUI
};
})(window);
