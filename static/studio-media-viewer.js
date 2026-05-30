(function(global){
'use strict';
let opts = {};
let currentLightboxData = null;
let lightboxIndex = -1;

function tr(k){ return opts.tr ? opts.tr(k) : k; }
function escapeHtml(s){
  if(opts.escapeHtml) return opts.escapeHtml(s);
  return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function historyKey(item){ return opts.historyKey(item); }
function lightboxItems(){ return opts.lightboxItems ? opts.lightboxItems() : []; }
function providerById(id){ return opts.providerById ? opts.providerById(id) : null; }
function mediaUrl(item){ return opts.mediaUrl ? opts.mediaUrl(item) : ((item?.videos&&item.videos[0])||(item?.audios&&item.audios[0])||(item?.images&&item.images[0])||''); }
function isVideoItem(item){ return opts.isVideoItem ? opts.isVideoItem(item) : !!(item?.videos&&item.videos.length); }
function isAudioItem(item){ return opts.isAudioItem ? opts.isAudioItem(item) : !!(item?.audios&&item.audios.length); }
function isImageItem(item){ return opts.isImageItem ? opts.isImageItem(item) : !!(item?.images&&item.images.length) && !isVideoItem(item) && !isAudioItem(item); }
function getMediaKind(data){ if(isVideoItem(data)) return 'video'; if(isAudioItem(data)) return 'audio'; return 'image'; }

function ensureViewerMediaElements(){
  const stage = document.getElementById('viewerStage');
  if(!stage) return;
  if(!document.getElementById('viewerVideoEl')){
    const v = document.createElement('video');
    v.id = 'viewerVideoEl'; v.className = 'viewer-media-el'; v.controls = true; v.playsInline = true;
    stage.insertBefore(v, document.getElementById('viewerDrawCanvas'));
  }
  if(!document.getElementById('viewerAudioEl')){
    const a = document.createElement('audio');
    a.id = 'viewerAudioEl'; a.className = 'viewer-media-el'; a.controls = true;
    stage.insertBefore(a, document.getElementById('viewerDrawCanvas'));
  }
}

function setViewerMediaMode(kind){
  ensureViewerMediaElements();
  const img = document.getElementById('lightboxImg');
  const video = document.getElementById('viewerVideoEl');
  const audio = document.getElementById('viewerAudioEl');
  const draw = document.getElementById('viewerDrawCanvas');
  const crop = document.getElementById('viewerCropLayer');
  const brush = document.getElementById('viewerBrushCursor');
  const editSection = document.getElementById('lightboxEditSection');
  const copyBtn = document.querySelector('[data-viewer-action="copy-image"]');
  if(img) img.style.display = kind === 'image' ? 'block' : 'none';
  if(video){ video.style.display = kind === 'video' ? 'block' : 'none'; if(kind !== 'video'){ video.pause(); video.removeAttribute('src'); } }
  if(audio){ audio.style.display = kind === 'audio' ? 'block' : 'none'; if(kind !== 'audio'){ audio.pause(); audio.removeAttribute('src'); } }
  if(draw) draw.classList.toggle('hidden', kind !== 'image');
  if(crop) crop.classList.add('hidden');
  if(brush) brush.classList.remove('visible');
  if(editSection) editSection.classList.toggle('hidden', kind !== 'image');
  if(copyBtn) copyBtn.style.display = kind === 'image' ? '' : 'none';
}


function formatViewerTime(ts){
    if(!ts) return '—';
    try { return new Date(Number(ts) * 1000).toLocaleString(); } catch(e) { return String(ts); }
}
function isViewerEditedImage(data){
    const editType = data?.params?.edit_type;
    return editType === 'brush' || editType === 'crop';
}
function viewerProviderSource(data){
    const type = String(data?.type || '').trim().toLowerCase();
    const model = String(data.params?.model || data.model || '').trim();
    if(type === 'local-comfy') return 'comfyui';
    if(type === 'runninghub') return 'runninghub';
    const onlineTypes = new Set(['online', 'online-video', 'online-audio', 'online-image']);
    if(onlineTypes.has(type)){
        if(model) return model;
        return data.provider_name
            || providerById(data.params?.provider_id || data.provider_id)?.name
            || data.provider_id
            || '—';
    }
    if(model) return model;
    return data.provider_name
        || providerById(data.params?.provider_id || data.provider_id)?.name
        || data.provider_id
        || '—';
}
function viewerMetaRows(data){
    const rows = [];
    const edited = isViewerEditedImage(data);
    const providerName = viewerProviderSource(data);
            const kind = getMediaKind(data);
    const modelName = data.params?.model || data.model || '—';
    const size = data.params?.size || '—';
    if(data._displaySize) rows.unshift({ label: tr('online.viewerResolution') || 'Resolution', value: data._displaySize });
    if(!edited){
        rows.push({ label: tr('api.provider') || 'Platform', value: providerName });
        rows.push({ label: tr('online.model') || 'Model', value: modelName });
        rows.push({ label: tr('online.size') || 'Size', value: size });
    }
    if(data.seed != null) rows.push({ label: 'Seed', value: String(data.seed) });
    rows.push({ label: tr('online.viewerCreated') || 'Created', value: formatViewerTime(data.timestamp) });
    
            if(kind === 'video' && !edited){
                if(data.params?.duration) rows.push({ label: tr('canvas.videoDuration') || 'Duration', value: String(data.params.duration) + 's' });
                if(data.params?.aspect_ratio) rows.push({ label: tr('canvas.videoAspect') || 'Aspect', value: data.params.aspect_ratio });
                if(data.params?.resolution) rows.push({ label: tr('canvas.videoResolution') || 'Resolution', value: data.params.resolution });
            }
            if(kind === 'audio' && !edited && modelName !== '—') rows.push({ label: tr('online.model') || 'Model', value: modelName });

            if(data.params?.imported && !edited) rows.push({ label: tr('online.import') || 'Import', value: '✓' });
    return rows;
}
function renderViewerRefThumbs(data){
    const wrap = document.getElementById('lightboxRefsWrap');
    const el = document.getElementById('lightboxRefs');
    const refs = (data.params?.reference_images || []).filter(ref => ref?.url);
    if(!wrap || !el) return;
    if(!refs.length){
        wrap.classList.add('hidden');
        el.innerHTML = '';
        return;
    }
    wrap.classList.remove('hidden');
    el.innerHTML = refs.map((ref, i) => `
        <a href="${escapeHtml(ref.url)}" target="_blank" rel="noopener" class="viewer-ref-thumb" title="${escapeHtml(ref.name || ('Ref ' + (i + 1)))}">
            <img src="${escapeHtml(ref.url)}" alt="">
        </a>
    `).join('');
}
function renderViewerMetaGrid(container, rows){
    container.innerHTML = rows.map(row => `
        <div class="viewer-meta-cell">
            <div class="viewer-meta-label">${escapeHtml(row.label)}</div>
            <div class="viewer-meta-value">${escapeHtml(row.value)}</div>
        </div>
    `).join('');
}

const viewerEdit = { mode: 'brush', drawing: false, undoStack: [], lastPoint: null, cropDrag: null, cropRatio: '1:1', brushHue: 339, lastPointer: null };
const VIEWER_BRUSH_RATIO_MIN = 5;
const VIEWER_BRUSH_RATIO_MAX = 150;
const VIEWER_BRUSH_RATIO_DEFAULT = 16;

function getViewerImageMinDim(){
    const img = document.getElementById('lightboxImg');
    const nw = img?.naturalWidth || 1024;
    const nh = img?.naturalHeight || 1024;
    return Math.max(1, Math.min(nw, nh));
}

function getViewerBrushRatio(){
    const slider = document.getElementById('viewerBrushSize');
    const raw = Number(slider?.value || VIEWER_BRUSH_RATIO_DEFAULT);
    const clamped = Math.max(VIEWER_BRUSH_RATIO_MIN, Math.min(VIEWER_BRUSH_RATIO_MAX, raw));
    return clamped / 1000;
}

function getViewerBrushSizePx(){
    return Math.max(2, Math.round(getViewerImageMinDim() * getViewerBrushRatio()));
}

function syncViewerBrushSizeUI(){
    const slider = document.getElementById('viewerBrushSize');
    const valEl = document.getElementById('viewerBrushSizeVal');
    if(!slider) return;
    const ratioVal = Math.max(VIEWER_BRUSH_RATIO_MIN, Math.min(VIEWER_BRUSH_RATIO_MAX, Number(slider.value || VIEWER_BRUSH_RATIO_DEFAULT)));
    slider.value = String(ratioVal);
    const pct = (ratioVal / 10).toFixed(1);
    if(valEl) valEl.textContent = `${pct}%`;
}

function adjustViewerBrushSize(delta){
    const slider = document.getElementById('viewerBrushSize');
    if(!slider || viewerEdit.mode !== 'brush') return;
    const next = Math.max(VIEWER_BRUSH_RATIO_MIN, Math.min(VIEWER_BRUSH_RATIO_MAX, Number(slider.value || VIEWER_BRUSH_RATIO_DEFAULT) + delta));
    if(next === Number(slider.value)) return;
    slider.value = String(next);
    syncViewerBrushSizeUI();
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    if(viewerEdit.lastPointer) updateViewerBrushCursor(viewerEdit.lastPointer);
}
const VIEWER_CROP_RATIOS = [
    { id: '1:1', label: '1:1', w: 1, h: 1 },
    { id: '4:3', label: '4:3', w: 4, h: 3 },
    { id: '3:4', label: '3:4', w: 3, h: 4 },
    { id: '16:9', label: '16:9', w: 16, h: 9 },
    { id: '9:16', label: '9:16', w: 9, h: 16 },
    { id: '3:2', label: '3:2', w: 3, h: 2 },
    { id: '2:3', label: '2:3', w: 2, h: 3 },
    { id: 'custom', labelKey: 'online.cropCustom', w: 0, h: 0 }
];

function isViewerCropRatioLocked(){
    return viewerEdit.cropRatio !== 'custom';
}

function renderViewerCropRatios(){
    const wrap = document.getElementById('viewerCropRatios');
    if(!wrap) return;
    if(!wrap.dataset.ready){
        wrap.dataset.ready = '1';
        wrap.innerHTML = VIEWER_CROP_RATIOS.map(r => `
            <button type="button" class="viewer-crop-ratio" data-ratio="${r.id}" onclick="setViewerCropRatio('${r.id}')">${escapeHtml(r.labelKey ? tr(r.labelKey) : r.label)}</button>
        `).join('');
    }
    document.querySelectorAll('.viewer-crop-ratio').forEach(btn => {
        const r = VIEWER_CROP_RATIOS.find(x => x.id === btn.dataset.ratio);
        if(r?.labelKey) btn.textContent = tr(r.labelKey);
        btn.classList.toggle('active', btn.dataset.ratio === viewerEdit.cropRatio);
    });
}

function setViewerCropRatio(ratioId){
    viewerEdit.cropRatio = ratioId;
    renderViewerCropRatios();
    applyViewerCropRatioBox(ratioId !== 'custom');
}

function getViewerCropRatio(){
    return VIEWER_CROP_RATIOS.find(r => r.id === viewerEdit.cropRatio) || VIEWER_CROP_RATIOS.find(r => r.id === '1:1');
}

function getViewerImageDisplayRect(img){
    if(!img) return { left:0, top:0, width:0, height:0, scale:1, naturalWidth:1, naturalHeight:1 };
    const cw = img.clientWidth || 0;
    const ch = img.clientHeight || 0;
    const nw = img.naturalWidth || cw || 1;
    const nh = img.naturalHeight || ch || 1;
    if(!cw || !ch) return { left:0, top:0, width:cw, height:ch, scale:1, naturalWidth:nw, naturalHeight:nh };
    const scale = Math.min(cw / nw, ch / nh);
    const width = nw * scale;
    const height = nh * scale;
    return {
        left: (cw - width) / 2,
        top: (ch - height) / 2,
        width,
        height,
        scale,
        naturalWidth: nw,
        naturalHeight: nh
    };
}

function viewerDisplayToNaturalRect(left, top, width, height){
    const img = document.getElementById('lightboxImg');
    const disp = getViewerImageDisplayRect(img);
    const relLeft = Math.max(left, disp.left) - disp.left;
    const relTop = Math.max(top, disp.top) - disp.top;
    const relRight = Math.min(left + width, disp.left + disp.width) - disp.left;
    const relBottom = Math.min(top + height, disp.top + disp.height) - disp.top;
    const scale = disp.scale || 1;
    let w = Math.max(1, Math.round((relRight - relLeft) / scale));
    let h = Math.max(1, Math.round((relBottom - relTop) / scale));
    let x = Math.max(0, Math.round(relLeft / scale));
    let y = Math.max(0, Math.round(relTop / scale));
    if(isViewerCropRatioLocked()){
        const ratio = getViewerCropRatio();
        const target = ratio.w / ratio.h;
        if(w / h > target) w = Math.max(1, Math.round(h * target));
        else h = Math.max(1, Math.round(w / target));
    }
    return { x, y, w, h };
}

function resetViewerCropBoxCustom(){
    const img = document.getElementById('lightboxImg');
    const box = document.getElementById('viewerCropBox');
    const disp = getViewerImageDisplayRect(img);
    if(!img || !box || !disp.width) return;
    const w = disp.width * 0.8;
    const h = disp.height * 0.8;
    box.style.left = Math.round(disp.left + (disp.width - w) / 2) + 'px';
    box.style.top = Math.round(disp.top + (disp.height - h) / 2) + 'px';
    box.style.width = Math.round(w) + 'px';
    box.style.height = Math.round(h) + 'px';
}

function fitViewerCropBoxToRatio(ratioDef, keepCenter){
    const img = document.getElementById('lightboxImg');
    const box = document.getElementById('viewerCropBox');
    const disp = getViewerImageDisplayRect(img);
    if(!img || !box || !disp.width || !ratioDef?.w) return;
    const iw = disp.width;
    const ih = disp.height;
    const target = ratioDef.w / ratioDef.h;
    const curW = parseFloat(box.style.width) || iw * 0.8;
    const curH = parseFloat(box.style.height) || ih * 0.8;
    const curLeft = parseFloat(box.style.left) || disp.left + (iw - curW) / 2;
    const curTop = parseFloat(box.style.top) || disp.top + (ih - curH) / 2;
    const centerX = curLeft + curW / 2;
    const centerY = curTop + curH / 2;
    let w, h;
    if(iw / ih > target){
        h = ih * 0.82;
        w = h * target;
    } else {
        w = iw * 0.82;
        h = w / target;
    }
    if(keepCenter){
        const area = curW * curH;
        h = Math.sqrt(area / target);
        w = h * target;
        w = Math.min(w, iw);
        h = Math.min(h, ih);
    } else {
        w = Math.min(w, iw);
        h = Math.min(h, ih);
    }
    let left = keepCenter ? centerX - w / 2 : disp.left + (iw - w) / 2;
    let top = keepCenter ? centerY - h / 2 : disp.top + (ih - h) / 2;
    left = Math.min(Math.max(disp.left, left), Math.max(disp.left, disp.left + iw - w));
    top = Math.min(Math.max(disp.top, top), Math.max(disp.top, disp.top + ih - h));
    box.style.width = Math.round(w) + 'px';
    box.style.height = Math.round(h) + 'px';
    box.style.left = Math.round(left) + 'px';
    box.style.top = Math.round(top) + 'px';
}

function applyViewerCropRatioBox(keepCenter){
    const img = document.getElementById('lightboxImg');
    const box = document.getElementById('viewerCropBox');
    const ratio = getViewerCropRatio();
    if(!img || !box || !img.clientWidth) return;
    if(ratio.id === 'custom'){
        if(!parseFloat(box.style.width)) resetViewerCropBoxCustom();
        return;
    }
    fitViewerCropBoxToRatio(ratio, !!keepCenter);
}

function hideViewerBrushCursor(){
    document.getElementById('viewerBrushCursor')?.classList.remove('visible');
}

function viewerBrushColorFromHue(hue){
    const h = ((Number(hue) % 360) + 360) % 360;
    const s = 100;
    const l = 50;
    const sat = s / 100;
    const light = l / 100;
    const c = (1 - Math.abs(2 * light - 1)) * sat;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = light - c / 2;
    let r = 0;
    let g = 0;
    let b = 0;
    if(h < 60){ r = c; g = x; }
    else if(h < 120){ r = x; g = c; }
    else if(h < 180){ g = c; b = x; }
    else if(h < 240){ g = x; b = c; }
    else if(h < 300){ r = x; b = c; }
    else { r = c; b = x; }
    const toHex = n => Math.round((n + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function getViewerBrushColor(){
    return document.getElementById('viewerBrushColor')?.value || viewerBrushColorFromHue(viewerEdit.brushHue ?? 339);
}

function setViewerBrushHue(hue){
    const nextHue = ((Number(hue) % 360) + 360) % 360;
    viewerEdit.brushHue = nextHue;
    const color = viewerBrushColorFromHue(nextHue);
    const hidden = document.getElementById('viewerBrushColor');
    const thumb = document.getElementById('viewerHueThumb');
    const bar = document.getElementById('viewerHueBar');
    const swatch = document.getElementById('viewerBrushColorSwatch');
    const cursor = document.getElementById('viewerBrushCursor');
    if(hidden) hidden.value = color;
    if(thumb){
        thumb.style.left = `${(nextHue / 360) * 100}%`;
        thumb.style.background = color;
    }
    if(swatch) swatch.style.background = color;
    if(bar) bar.setAttribute('aria-valuenow', String(Math.round(nextHue)));
    if(cursor) cursor.style.borderColor = color;
}

function viewerHueFromPointer(e, bar){
    const rect = bar.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    return (x / Math.max(rect.width, 1)) * 360;
}

function bindViewerHueBar(){
    const bar = document.getElementById('viewerHueBar');
    if(!bar || bar.dataset.bound) return;
    bar.dataset.bound = '1';
    const applyPointer = e => setViewerBrushHue(viewerHueFromPointer(e, bar));
    bar.addEventListener('pointerdown', e => {
        e.preventDefault();
        applyPointer(e);
        bar.setPointerCapture?.(e.pointerId);
        const move = ev => applyPointer(ev);
        const up = ev => {
            bar.removeEventListener('pointermove', move);
            try { bar.releasePointerCapture?.(ev.pointerId); } catch(err) {}
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', up);
        bar.addEventListener('pointercancel', up);
    });
    setViewerBrushHue(viewerEdit.brushHue ?? 339);
}

function updateViewerBrushCursor(e){
    const cursor = document.getElementById('viewerBrushCursor');
    const canvas = document.getElementById('viewerDrawCanvas');
    const stage = document.getElementById('viewerStage');
    if(viewerEdit.mode !== 'brush' || !cursor || !canvas || !stage){
        hideViewerBrushCursor();
        return;
    }
    const rect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    if(e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom){
        hideViewerBrushCursor();
        return;
    }
    const size = getViewerBrushSizePx();
    const scale = rect.width / Math.max(canvas.width, 1);
    const d = Math.max(4, size * scale);
    cursor.style.width = d + 'px';
    cursor.style.height = d + 'px';
    cursor.style.left = (e.clientX - stageRect.left) + 'px';
    cursor.style.top = (e.clientY - stageRect.top) + 'px';
    cursor.style.borderColor = getViewerBrushColor();
    cursor.classList.add('visible');
}

function setViewerEditMode(mode){
    const prevMode = viewerEdit.mode;
    viewerEdit.mode = mode;
    document.getElementById('viewerModeBrush')?.classList.toggle('active', mode === 'brush');
    document.getElementById('viewerModeCrop')?.classList.toggle('active', mode === 'crop');
    document.getElementById('viewerModeGrid')?.classList.toggle('active', mode === 'grid');
    document.getElementById('viewerBrushPanel')?.classList.toggle('hidden', mode !== 'brush');
    document.getElementById('viewerCropPanel')?.classList.toggle('hidden', mode !== 'crop');
    document.getElementById('viewerGridPanel')?.classList.toggle('hidden', mode !== 'grid');
    const canvas = document.getElementById('viewerDrawCanvas');
    const cropLayer = document.getElementById('viewerCropLayer');
    canvas?.classList.toggle('viewer-draw-active', mode === 'brush');
    cropLayer?.classList.toggle('hidden', mode !== 'crop');

    const ctx = canvas?.getContext('2d');
    if(ctx){
        const leavingGridGuides = prevMode === 'grid' && mode !== 'grid';
        if(mode !== 'brush' || leavingGridGuides){
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        if(mode === 'brush' && leavingGridGuides){
            viewerEdit.undoStack = [];
            pushViewerDrawUndo();
        }
    }

    if(mode === 'crop'){
        hideViewerBrushCursor();
        renderViewerCropRatios();
        applyViewerCropRatioBox();
    } else if(mode === 'grid'){
        hideViewerBrushCursor();
        refreshViewerGridSplitPreview();
    } else if(mode === 'brush'){
        hideViewerBrushCursor();
    }
    lucide.createIcons();
}

function resetViewerDrawCanvas(){
    const canvas = document.getElementById('viewerDrawCanvas');
    const ctx = canvas?.getContext('2d');
    if(!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    viewerEdit.undoStack = [];
    pushViewerDrawUndo();
}

function layoutViewerDrawCanvas(){
    const img = document.getElementById('lightboxImg');
    const canvas = document.getElementById('viewerDrawCanvas');
    if(!img || !canvas || !img.complete || !img.naturalWidth) return false;
    const nw = Math.max(1, img.naturalWidth);
    const nh = Math.max(1, img.naturalHeight);
    canvas.width = nw;
    canvas.height = nh;
    const disp = getViewerImageDisplayRect(img);
    canvas.style.left = `${disp.left}px`;
    canvas.style.top = `${disp.top}px`;
    canvas.style.width = `${disp.width}px`;
    canvas.style.height = `${disp.height}px`;
    canvas.style.right = 'auto';
    canvas.style.bottom = 'auto';
    return true;
}

function syncViewerDrawCanvas(){
    const img = document.getElementById('lightboxImg');
    if(!img) return;
    const run = () => {
        if(!layoutViewerDrawCanvas()) return;
        resetViewerDrawCanvas();
        syncViewerBrushSizeUI();
        if(viewerEdit.mode === 'crop') initViewerCropBox();
    };
    if(img.complete && img.naturalWidth){
        requestAnimationFrame(() => requestAnimationFrame(run));
    } else {
        img.addEventListener('load', () => requestAnimationFrame(() => requestAnimationFrame(run)), { once: true });
    }
}

function pushViewerDrawUndo(){
    const canvas = document.getElementById('viewerDrawCanvas');
    const ctx = canvas?.getContext('2d');
    if(!canvas || !ctx || !canvas.width || !canvas.height) return;
    try {
        viewerEdit.undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
        if(viewerEdit.undoStack.length > 30) viewerEdit.undoStack.shift();
    } catch(e) {}
}

function undoViewerDraw(){
    const canvas = document.getElementById('viewerDrawCanvas');
    const ctx = canvas?.getContext('2d');
    if(!canvas || !ctx || viewerEdit.undoStack.length <= 1) return;
    viewerEdit.undoStack.pop();
    const prev = viewerEdit.undoStack[viewerEdit.undoStack.length - 1];
    if(prev) ctx.putImageData(prev, 0, 0);
}

function viewerCanvasPoint(e, canvas){
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / Math.max(canvas.width, 1);
    return {
        x: (e.clientX - rect.left) / scale,
        y: (e.clientY - rect.top) / scale,
    };
}

function beginViewerDraw(e){
    if(viewerEdit.mode !== 'brush') return;
    const canvas = document.getElementById('viewerDrawCanvas');
    if(!canvas) return;
    e.preventDefault();
    viewerEdit.drawing = true;
    pushViewerDrawUndo();
    const pt = viewerCanvasPoint(e, canvas);
    viewerEdit.lastPoint = pt;
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y);
    canvas.setPointerCapture?.(e.pointerId);
    updateViewerBrushCursor(e);
}

function moveViewerDraw(e){
    updateViewerBrushCursor(e);
    if(!viewerEdit.drawing || viewerEdit.mode !== 'brush') return;
    const canvas = document.getElementById('viewerDrawCanvas');
    const ctx = canvas?.getContext('2d');
    if(!canvas || !ctx) return;
    e.preventDefault();
    const pt = viewerCanvasPoint(e, canvas);
    const size = getViewerBrushSizePx();
    const color = getViewerBrushColor();
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y);
    viewerEdit.lastPoint = pt;
}

function endViewerDraw(e){
    if(!viewerEdit.drawing) return;
    viewerEdit.drawing = false;
    viewerEdit.lastPoint = null;
    const canvas = document.getElementById('viewerDrawCanvas');
    try { canvas?.releasePointerCapture?.(e.pointerId); } catch(err) {}
    updateViewerBrushCursor(e);
}

function initViewerCropBox(){
    viewerEdit.cropRatio = viewerEdit.cropRatio || '1:1';
    applyViewerCropRatioBox(false);
}

function clampViewerCropSize(width, height, maxW, maxH, minSize, target){
    let w = Math.max(minSize, width);
    let h = Math.max(minSize, height);
    if(target){
        if(w / h > target) w = h * target;
        else h = w / target;
    }
    if(w > maxW){
        w = maxW;
        if(target) h = w / target;
    }
    if(h > maxH){
        h = maxH;
        if(target) w = h * target;
    }
    w = Math.max(minSize, Math.min(maxW, w));
    h = Math.max(minSize, Math.min(maxH, h));
    if(target){
        const nextH = w / target;
        if(nextH <= maxH) h = nextH;
        else { h = maxH; w = h * target; }
    }
    return { width: w, height: h };
}

function resizeViewerCropFromCorner(drag, dx, dy, corner){
    const minSize = 24;
    const target = isViewerCropRatioLocked() ? getViewerCropRatio().w / getViewerCropRatio().h : 0;
    let left = drag.left;
    let top = drag.top;
    let width = drag.width;
    let height = drag.height;
    if(corner === 'se'){
        width = drag.width + dx;
        height = drag.height + dy;
    } else if(corner === 'sw'){
        width = drag.width - dx;
        height = drag.height + dy;
        left = drag.left + drag.width - width;
    } else if(corner === 'ne'){
        width = drag.width + dx;
        height = drag.height - dy;
        top = drag.top + drag.height - height;
    } else if(corner === 'nw'){
        width = drag.width - dx;
        height = drag.height - dy;
        left = drag.left + drag.width - width;
        top = drag.top + drag.height - height;
    }
    if(target){
        if(Math.abs(dx) >= Math.abs(dy)) height = width / target;
        else width = height * target;
        if(corner === 'se'){
            left = drag.left;
            top = drag.top;
        } else if(corner === 'sw'){
            left = drag.left + drag.width - width;
            top = drag.top;
        } else if(corner === 'ne'){
            left = drag.left;
            top = drag.top + drag.height - height;
        } else if(corner === 'nw'){
            left = drag.left + drag.width - width;
            top = drag.top + drag.height - height;
        }
    }
    width = Math.max(minSize, width);
    height = Math.max(minSize, height);
    left = Math.max(drag.minLeft, Math.min(drag.maxLeft - width, left));
    top = Math.max(drag.minTop, Math.min(drag.maxTop - height, top));
    width = Math.min(width, drag.maxLeft - left);
    height = Math.min(height, drag.maxTop - top);
    if(target){
        if(width / height > target) width = height * target;
        else height = width / target;
        width = Math.max(minSize, Math.min(drag.maxLeft - left, width));
        height = Math.max(minSize, Math.min(drag.maxTop - top, height));
        if(corner === 'se'){
            left = Math.max(drag.minLeft, Math.min(drag.maxLeft - width, drag.left));
            top = Math.max(drag.minTop, Math.min(drag.maxTop - height, drag.top));
        } else if(corner === 'sw'){
            left = Math.max(drag.minLeft, drag.left + drag.width - width);
            top = Math.max(drag.minTop, Math.min(drag.maxTop - height, drag.top));
        } else if(corner === 'ne'){
            left = Math.max(drag.minLeft, Math.min(drag.maxLeft - width, drag.left));
            top = Math.max(drag.minTop, drag.top + drag.height - height);
        } else if(corner === 'nw'){
            left = Math.max(drag.minLeft, drag.left + drag.width - width);
            top = Math.max(drag.minTop, drag.top + drag.height - height);
        }
        width = Math.min(width, drag.maxLeft - left);
        height = Math.min(height, drag.maxTop - top);
    }
    return { left, top, width, height };
}

function beginViewerCropDrag(e, kind){
    if(viewerEdit.mode !== 'crop') return;
    e.preventDefault();
    e.stopPropagation();
    const box = document.getElementById('viewerCropBox');
    const img = document.getElementById('lightboxImg');
    const disp = getViewerImageDisplayRect(img);
    if(!box || !img || !disp.width) return;
    viewerEdit.cropDrag = {
        kind,
        startX: e.clientX,
        startY: e.clientY,
        left: parseFloat(box.style.left) || disp.left,
        top: parseFloat(box.style.top) || disp.top,
        width: parseFloat(box.style.width) || disp.width * 0.8,
        height: parseFloat(box.style.height) || disp.height * 0.8,
        minLeft: disp.left,
        minTop: disp.top,
        maxLeft: disp.left + disp.width,
        maxTop: disp.top + disp.height
    };
    window.addEventListener('pointermove', moveViewerCropDrag);
    window.addEventListener('pointerup', endViewerCropDrag, { once: true });
}

function moveViewerCropDrag(e){
    const drag = viewerEdit.cropDrag;
    const box = document.getElementById('viewerCropBox');
    if(!drag || !box) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if(drag.kind === 'move'){
        const maxLeft = drag.maxLeft - drag.width;
        const maxTop = drag.maxTop - drag.height;
        box.style.left = Math.min(maxLeft, Math.max(drag.minLeft, drag.left + dx)) + 'px';
        box.style.top = Math.min(maxTop, Math.max(drag.minTop, drag.top + dy)) + 'px';
        return;
    }
    const next = resizeViewerCropFromCorner(drag, dx, dy, drag.kind);
    box.style.left = next.left + 'px';
    box.style.top = next.top + 'px';
    box.style.width = next.width + 'px';
    box.style.height = next.height + 'px';
}

function endViewerCropDrag(){
    viewerEdit.cropDrag = null;
    window.removeEventListener('pointermove', moveViewerCropDrag);
}

async function getViewerMergedCanvas(){
    const img = document.getElementById('lightboxImg');
    const drawCanvas = document.getElementById('viewerDrawCanvas');
    if(!img || !img.complete) return null;
    const merged = document.createElement('canvas');
    merged.width = img.naturalWidth;
    merged.height = img.naturalHeight;
    const ctx = merged.getContext('2d');
    ctx.drawImage(img, 0, 0);
    if(drawCanvas?.width) ctx.drawImage(drawCanvas, 0, 0);
    return merged;
}

function viewerDrawCanvasHasStrokes(){
    const canvas = document.getElementById('viewerDrawCanvas');
    const ctx = canvas?.getContext('2d');
    if(!canvas || !ctx) return false;
    try {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for(let i = 3; i < data.length; i += 4){
            if(data[i] > 0) return true;
        }
    } catch(e) {}
    return false;
}

async function getViewerCroppedCanvas(){
    const img = document.getElementById('lightboxImg');
    const box = document.getElementById('viewerCropBox');
    if(!img || !box || !img.clientWidth) return null;
    const merged = await getViewerMergedCanvas();
    if(!merged) return null;
    const boxLeft = parseFloat(box.style.left) || 0;
    const boxTop = parseFloat(box.style.top) || 0;
    const boxW = parseFloat(box.style.width) || 0;
    const boxH = parseFloat(box.style.height) || 0;
    const { x, y, w, h } = viewerDisplayToNaturalRect(boxLeft, boxTop, boxW, boxH);
    const out = document.createElement('canvas');
    out.width = Math.min(w, merged.width - x);
    out.height = Math.min(h, merged.height - y);
    out.getContext('2d').drawImage(merged, x, y, out.width, out.height, 0, 0, out.width, out.height);
    return out;
}

async function restoreViewerOriginal(){
    const source = currentLightboxData;
    const img = document.getElementById('lightboxImg');
    if(!source?.images?.[0] || !img) return;
    await new Promise(resolve => {
        if(img.src === source.images[0] && img.complete){ resolve(); return; }
        img.onload = () => resolve();
        img.src = source.images[0];
    });
    resetViewerDrawCanvas();
    if(viewerEdit.mode === 'crop') applyViewerCropRatioBox();
}

async function importEditedViewerCanvas(canvas, editType){
    const source = currentLightboxData;
    if(!canvas || !source) return null;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if(!blob) return null;
    const file = new File([blob], `online_edit_${Date.now()}.png`, { type: 'image/png' });
    const form = new FormData();
    form.append('files', file);
    const res = await fetch('/api/online-import', { method:'POST', body: form });
    if(!res.ok) throw new Error('Import failed');
    const data = await res.json();
    const items = (data.items || []).map(item => ({
        ...item,
        prompt: source.prompt || item.prompt || '',
        model: source.model || source.params?.model || item.model || '',
        provider_id: source.provider_id || source.params?.provider_id || item.provider_id || '',
        provider_name: source.provider_name || item.provider_name || '',
        params: {
            ...(source.params || {}),
            imported: true,
            edited_from: historyKey(source),
            edit_type: editType,
            reference_images: source.params?.reference_images || []
        }
    }));
    items.forEach(item => { if(opts.onUpsertItem) opts.onUpsertItem(item); });
    if(opts.onRefresh) opts.onRefresh();
    return items[0] || null;
}

async function getViewerGridSlicedCanvases(){
    const img = document.getElementById('lightboxImg');
    if(!img || !img.naturalWidth || !img.naturalHeight) return null;
    const hLines = Math.max(0, Math.min(20, Number(document.getElementById('viewerGridHorizontalLines')?.value || 0)));
    const vLines = Math.max(0, Math.min(20, Number(document.getElementById('viewerGridVerticalLines')?.value || 0)));
    const gap = Math.max(0, Math.min(240, Number(document.getElementById('viewerGridGapSize')?.value || 0)));
    
    const rows = hLines + 1;
    const cols = vLines + 1;
    const halfGap = gap / 2;
    
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    const rects = [];
    for(let row = 0; row < rows; row++){
        const topLine = row * height / rows;
        const bottomLine = (row + 1) * height / rows;
        const y1 = Math.round(row === 0 ? 0 : topLine + halfGap);
        const y2 = Math.round(row === rows - 1 ? height : bottomLine - halfGap);
        for(let col = 0; col < cols; col++){
            const leftLine = col * width / cols;
            const rightLine = (col + 1) * width / cols;
            const x1 = Math.round(col === 0 ? 0 : leftLine + halfGap);
            const x2 = Math.round(col === cols - 1 ? width : rightLine - halfGap);
            if(x2 > x1 && y2 > y1) rects.push({row, col, x:x1, y:y1, w:x2 - x1, h:y2 - y1});
        }
    }
    
    const canvases = [];
    for(const rect of rects){
        const canvasEl = document.createElement('canvas');
        canvasEl.width = rect.w;
        canvasEl.height = rect.h;
        canvasEl.getContext('2d').drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
        canvases.push({ canvas: canvasEl, row: rect.row, col: rect.col });
    }
    return canvases;
}

async function importEditedViewerGridSlices(slices){
    const source = currentLightboxData;
    if(!slices || !slices.length || !source) return null;
    
    const form = new FormData();
    for(let i = 0; i < slices.length; i++){
        const { canvas, row, col } = slices[i];
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if(!blob) continue;
        const file = new File([blob], `grid_split_r${row + 1}_c${col + 1}_${Date.now()}.png`, { type: 'image/png' });
        form.append('files', file);
    }
    
    const res = await fetch('/api/online-import', { method:'POST', body: form });
    if(!res.ok) throw new Error('Import failed');
    const data = await res.json();
    const items = (data.items || []).map((item, idx) => ({
        ...item,
        prompt: source.prompt || item.prompt || '',
        model: source.model || source.params?.model || item.model || '',
        provider_id: source.provider_id || source.params?.provider_id || item.provider_id || '',
        provider_name: source.provider_name || item.provider_name || '',
        params: {
            ...(source.params || {}),
            imported: true,
            edited_from: historyKey(source),
            edit_type: 'grid_split',
            reference_images: source.params?.reference_images || []
        }
    }));
    items.forEach(item => { if(opts.onUpsertItem) opts.onUpsertItem(item); });
    if(opts.onRefresh) opts.onRefresh();
    return items[0] || null;
}

function applyViewerGridPreset(rows, cols){
    const hLinesInput = document.getElementById('viewerGridHorizontalLines');
    const vLinesInput = document.getElementById('viewerGridVerticalLines');
    if(hLinesInput) hLinesInput.value = rows - 1;
    if(vLinesInput) vLinesInput.value = cols - 1;
    refreshViewerGridSplitPreview();
}

function refreshViewerGridSplitPreview(){
    const canvas = document.getElementById('viewerDrawCanvas');
    if(!canvas || viewerEdit.mode !== 'grid') return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const hLines = Math.max(0, Math.min(20, Number(document.getElementById('viewerGridHorizontalLines')?.value || 0)));
    const vLines = Math.max(0, Math.min(20, Number(document.getElementById('viewerGridVerticalLines')?.value || 0)));
    const gap = Math.max(0, Math.min(240, Number(document.getElementById('viewerGridGapSize')?.value || 0)));
    
    const rows = hLines + 1;
    const cols = vLines + 1;
    const scaleX = canvas.width;
    const scaleY = canvas.height;
    
    const countEl = document.getElementById('viewerGridSplitCount');
    if(countEl) {
        countEl.textContent = (tr('canvas.gridWillOutput') || '预计输出 {n} 张图片').replace('{n}', rows * cols);
    }
    
    const lineWidth = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) / 320));
    const drawGuideLine = (x1, y1, x2, y2) => {
        ctx.save();
        ctx.lineWidth = lineWidth + 2;
        ctx.strokeStyle = 'rgba(2,6,23,0.72)';
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.restore();
    };
    
    for(let i = 1; i < cols; i++){
        const x = i * scaleX / cols;
        if(gap > 0){
            drawGuideLine(x - gap / 2, 0, x - gap / 2, scaleY);
            drawGuideLine(x + gap / 2, 0, x + gap / 2, scaleY);
        } else {
            drawGuideLine(x, 0, x, scaleY);
        }
    }
    for(let i = 1; i < rows; i++){
        const y = i * scaleY / rows;
        if(gap > 0){
            drawGuideLine(0, y - gap / 2, scaleX, y - gap / 2);
            drawGuideLine(0, y + gap / 2, scaleX, y + gap / 2);
        } else {
            drawGuideLine(0, y, scaleX, y);
        }
    }
}

async function confirmViewerEdit(){
    const mode = viewerEdit.mode;
    try {
        let newItem = null;
        if(mode === 'brush'){
            if(!viewerDrawCanvasHasStrokes()){
                alert(tr('online.viewerNoEdit') || '请先在图片上涂抹');
                return;
            }
            const merged = await getViewerMergedCanvas();
            if(!merged) return;
            newItem = await importEditedViewerCanvas(merged, 'brush');
        } else if(mode === 'crop'){
            const cropped = await getViewerCroppedCanvas();
            if(!cropped) return;
            newItem = await importEditedViewerCanvas(cropped, 'crop');
        } else if(mode === 'grid'){
            const slices = await getViewerGridSlicedCanvases();
            if(!slices || !slices.length) return;
            newItem = await importEditedViewerGridSlices(slices);
        } else {
            return;
        }
        closeLightbox();
        
        lucide.createIcons();
    } catch(e) {
        alert(tr('online.importFailed') || '保存失败');
    }
}

function initViewerEditTools(){
    const canvas = document.getElementById('viewerDrawCanvas');
    if(!canvas || canvas.dataset.bound) return;
    canvas.dataset.bound = '1';
    canvas.addEventListener('pointerdown', beginViewerDraw);
    canvas.addEventListener('pointermove', moveViewerDraw);
    canvas.addEventListener('pointerup', endViewerDraw);
    canvas.addEventListener('pointercancel', endViewerDraw);
    canvas.addEventListener('pointerleave', e => {
        if(!viewerEdit.drawing) hideViewerBrushCursor();
    });
    bindViewerHueBar();
    syncViewerBrushSizeUI();
    document.getElementById('viewerBrushSize')?.addEventListener('input', () => {
        syncViewerBrushSizeUI();
        const evt = viewerEdit.lastPointer;
        if(evt) updateViewerBrushCursor(evt);
    });
    document.getElementById('viewerStage')?.addEventListener('pointermove', e => {
        viewerEdit.lastPointer = e;
        updateViewerBrushCursor(e);
    });
    document.getElementById('viewerStage')?.addEventListener('wheel', e => {
        if(viewerEdit.mode !== 'brush') return;
        if(!document.getElementById('lightbox')?.classList.contains('open')) return;
        e.preventDefault();
        adjustViewerBrushSize(e.deltaY > 0 ? -2 : 2);
    }, { passive: false });
    document.getElementById('viewerCropBox')?.addEventListener('pointerdown', e => {
        if(e.target.closest('.viewer-crop-handle')) return;
        beginViewerCropDrag(e, 'move');
    });
    document.querySelectorAll('.viewer-crop-handle').forEach(handle => {
        handle.addEventListener('pointerdown', e => {
            e.stopPropagation();
            beginViewerCropDrag(e, handle.dataset.corner);
        });
    });
    window.addEventListener('resize', () => {
        if(document.getElementById('lightbox')?.classList.contains('open')) syncViewerDrawCanvas();
    });
}

function renderLightboxSidebar(data){
    const info = document.getElementById('lightboxInfo');
    const promptEl = document.getElementById('lightboxPrompt');
    const promptSection = document.getElementById('lightboxPromptSection');
    const edited = isViewerEditedImage(data);
    renderViewerRefThumbs(data);
    renderViewerMetaGrid(info, viewerMetaRows(data));
    if(promptSection) promptSection.classList.toggle('hidden', edited);
    const prompt = (data.prompt || '').trim();
    promptEl.textContent = prompt || (tr('online.viewerNoPrompt') || 'No prompt');
    promptEl.classList.toggle('empty', !prompt);
    const key = historyKey(data);
    document.getElementById('viewerFavBtn')?.classList.toggle('active', opts.isFavorite ? opts.isFavorite(data) : false);
    document.getElementById('viewerPinBtn')?.classList.toggle('pin-active', opts.isPinned ? opts.isPinned(data) : false);
}
function updateViewerNav(){
    const items = lightboxItems();
    const prev = document.getElementById('viewerPrev');
    const next = document.getElementById('viewerNext');
    if(prev) prev.disabled = lightboxIndex <= 0;
    if(next) next.disabled = lightboxIndex < 0 || lightboxIndex >= items.length - 1;
}
function showLightboxAt(index){
    const items = lightboxItems();
    if(!items.length) return;
    lightboxIndex = Math.min(items.length - 1, Math.max(0, index));
    openLightbox(items[lightboxIndex], { preserveIndex: true });
}
function viewerNav(delta){
    if(lightboxIndex < 0) return;
    showLightboxAt(lightboxIndex + delta);
}
function openLightbox(data, options = {}){
            if(!data) return;
            currentLightboxData = data;
            if(!options.preserveIndex){
                const items = lightboxItems();
                lightboxIndex = items.findIndex(item => historyKey(item) === historyKey(data));
            }
            const kind = getMediaKind(data);
            const url = mediaUrl(data);
            setViewerMediaMode(kind);
            if(kind === 'image'){
                const img = document.getElementById('lightboxImg');
                const onReady = () => {
                    syncViewerDrawCanvas();
                    const enriched = {
                        ...data,
                        _displaySize: img.naturalWidth && img.naturalHeight ? `${img.naturalWidth}×${img.naturalHeight}` : (data.params?.size || '')
                    };
                    if(currentLightboxData && historyKey(currentLightboxData) === historyKey(data)) currentLightboxData = enriched;
                    renderLightboxSidebar(enriched);
                };
                img.onload = onReady;
                img.src = url;
                if(img.complete && img.naturalWidth) onReady();
                viewerEdit.cropRatio = '1:1';
                setViewerEditMode('brush');
                renderLightboxSidebar(data);
                initViewerEditTools();
            } else if(kind === 'video'){
                const video = document.getElementById('viewerVideoEl');
                video.onloadedmetadata = () => {
                    const enriched = { ...data, _displaySize: video.videoWidth && video.videoHeight ? `${video.videoWidth}×${video.videoHeight}` : '' };
                    if(currentLightboxData && historyKey(currentLightboxData) === historyKey(data)) currentLightboxData = enriched;
                    renderLightboxSidebar(enriched);
                };
                video.src = url;
                renderLightboxSidebar(data);
            } else {
                const audio = document.getElementById('viewerAudioEl');
                audio.src = url;
                renderLightboxSidebar(data);
            }
            updateViewerNav();
            document.getElementById('lightbox').classList.add('open');
            document.body.style.overflow = 'hidden';
            if(global.lucide) lucide.createIcons();
        }
function closeLightbox(){
    document.getElementById('lightbox').classList.remove('open');
    document.body.style.overflow = '';
    lightboxIndex = -1;
    viewerEdit.drawing = false;
    viewerEdit.cropDrag = null;
    setViewerEditMode('brush');
}
function handleOutsideClick(e){ if(e.target.id === 'lightbox') closeLightbox(); }
function copyLightboxPrompt(ev){
    ev?.stopPropagation();
    const text = currentLightboxData?.prompt || '';
    if(!text) return;
    navigator.clipboard?.writeText(text).catch(() => {});
}
async function copyLightboxImage(ev){
    ev?.stopPropagation();
    const merged = await getViewerMergedCanvas();
    if(!merged) return;
    try {
        const blob = await new Promise(resolve => merged.toBlob(resolve, 'image/png'));
        if(blob && navigator.clipboard?.write && window.ClipboardItem){
            await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        }
    } catch(e) {}
}
function openLightboxFullscreen(ev){
    ev?.stopPropagation();
    const img = document.getElementById('lightboxImg');
    const el = img?.requestFullscreen ? img : document.getElementById('lightboxFrame');
    el?.requestFullscreen?.().catch(() => {});
}
function toggleViewerFavorite(){
    if(!currentLightboxData) return;
    opts.toggleFavorite && opts.toggleFavorite(currentLightboxData);
    renderLightboxSidebar(currentLightboxData);
}
function toggleViewerPin(){
    if(!currentLightboxData) return;
    opts.togglePin && opts.togglePin(currentLightboxData);
    renderLightboxSidebar(currentLightboxData);
}
function applySameStyle(){
    if(!currentLightboxData) return;
    if(opts.onApplyParams) opts.onApplyParams(currentLightboxData);
    closeLightbox();
}
async function downloadLightboxImage(e){
    e?.stopPropagation();
    const data = currentLightboxData;
    const kind = data ? getMediaKind(data) : 'image';
    if(kind !== 'image'){
        const url = mediaUrl(data);
        if(!url) return;
        const link = document.createElement('a');
        link.href = url;
        link.download = url.split('/').pop() || 'media';
        document.body.appendChild(link);
        link.click();
        link.remove();
        return;
    }
    const merged = await getViewerMergedCanvas();
    if(!merged) return;
    const link = document.createElement('a');
    link.href = merged.toDataURL('image/png');
    link.download = `studio-image-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
}
function bindViewerGlobals(){
  global.viewerNav = viewerNav;
  global.closeLightbox = closeLightbox;
  global.handleOutsideClick = handleOutsideClick;
  global.copyLightboxPrompt = copyLightboxPrompt;
  global.copyLightboxImage = copyLightboxImage;
  global.downloadLightboxImage = downloadLightboxImage;
  global.openLightboxFullscreen = openLightboxFullscreen;
  global.toggleViewerFavorite = toggleViewerFavorite;
  global.toggleViewerPin = toggleViewerPin;
  global.setViewerEditMode = setViewerEditMode;
  global.undoViewerDraw = undoViewerDraw;
  global.confirmViewerEdit = confirmViewerEdit;
  global.setViewerCropRatio = setViewerCropRatio;
  global.applySameStyle = applySameStyle;
  global.applyViewerGridPreset = applyViewerGridPreset;
  global.refreshViewerGridSplitPreview = refreshViewerGridSplitPreview;
  global.syncViewerBrushSizeUI = syncViewerBrushSizeUI;
  if(!global._studioViewerKeyBound){
    global._studioViewerKeyBound = true;
    document.addEventListener('keydown', e => {
      const open = document.getElementById('lightbox')?.classList.contains('open');
      if(!open) return;
      if(e.key === 'Escape') closeLightbox();
      if(e.key === 'ArrowLeft') viewerNav(-1);
      if(e.key === 'ArrowRight') viewerNav(1);
    });
  }
}

global.StudioMediaViewer = {
  init(options = {}){
    opts = options;
    bindViewerGlobals();
    initViewerEditTools();
  },
  open(data, options){ return openLightbox(data, options); },
  close(){ return closeLightbox(); },
  refresh(){
    if(currentLightboxData) renderLightboxSidebar(currentLightboxData);
    updateViewerNav();
  }
};
})(window);
