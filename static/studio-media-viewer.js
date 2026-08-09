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
  const textLayer = document.getElementById('viewerTextLayer');
  const crop = document.getElementById('viewerCropLayer');
  const brush = document.getElementById('viewerBrushCursor');
  const editSection = document.getElementById('lightboxEditSection');
  const copyBtn = document.querySelector('[data-viewer-action="copy-image"]');
  if(img) img.style.display = kind === 'image' ? 'block' : 'none';
  if(video){ video.style.display = kind === 'video' ? 'block' : 'none'; if(kind !== 'video'){ video.pause(); video.removeAttribute('src'); } }
  if(audio){ audio.style.display = kind === 'audio' ? 'block' : 'none'; if(kind !== 'audio'){ audio.pause(); audio.removeAttribute('src'); } }
  if(draw) draw.classList.toggle('hidden', kind !== 'image');
  if(textLayer){
    if(kind !== 'image'){
      textLayer.classList.add('hidden');
      textLayer.classList.remove('viewer-text-active');
      clearViewerTexts();
    }
  }
  if(crop) crop.classList.add('hidden');
  if(brush) brush.classList.remove('visible');
  if(editSection) editSection.classList.toggle('hidden', kind !== 'image');
  if(copyBtn) copyBtn.style.display = kind === 'image' ? '' : 'none';
  const captureBtn = document.getElementById('viewerCaptureFrameBtn');
  if(captureBtn){
    captureBtn.classList.toggle('is-visible', kind === 'video');
    captureBtn.disabled = false;
  }
}


function formatViewerTime(ts){
    if(!ts) return '—';
    try { return new Date(Number(ts) * 1000).toLocaleString(); } catch(e) { return String(ts); }
}
function isViewerEditedImage(data){
    const editType = data?.params?.edit_type;
    return editType === 'brush' || editType === 'crop' || editType === 'text';
}
function viewerProviderSource(data){
    const type = String(data?.type || '').trim().toLowerCase();
    if(type === 'local-comfy') return 'comfyui';
    if(type === 'runninghub') return 'runninghub';
    const onlineTypes = new Set(['online', 'online-video', 'online-audio', 'online-image']);
    if(onlineTypes.has(type)){
        return data.provider_name
            || providerById(data.params?.provider_id || data.provider_id)?.name
            || data.params?.provider_id
            || data.provider_id
            || '—';
    }
    const model = String(data.params?.model || data.model || '').trim();
    if(model) return model;
    return data.provider_name
        || providerById(data.params?.provider_id || data.provider_id)?.name
        || data.provider_id
        || '—';
}
function normalizeRefUrl(entry){
    if(entry == null) return '';
    if(typeof entry === 'string') return entry.trim();
    if(typeof entry === 'object') return String(entry.url || entry.value || '').trim();
    return String(entry).trim();
}
function fileNameFromUrl(url){
    const raw = String(url || '').trim();
    if(!raw) return 'media';
    try {
        const parsed = new URL(raw, location.origin);
        const base = parsed.pathname.split('/').pop();
        if(base) return base.split('?')[0] || base;
    } catch(e){}
    return raw.split('/').pop()?.split('?')[0] || raw.slice(0, 48);
}
function isImageUrl(url){
    return /\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/i.test(url) || /\/assets\/|\/output\//i.test(url);
}
function isVideoUrl(url){
    return /\.(mp4|webm|mov|m4v|avi|mkv)(\?|$)/i.test(url);
}
function isAudioUrl(url){
    return /\.(mp3|wav|m4a|aac|ogg|flac|opus|weba)(\?|$)/i.test(url);
}
function dedupeUrls(list){
    const out = [];
    const seen = new Set();
    (list || []).forEach(item => {
        const url = normalizeRefUrl(item);
        if(!url || seen.has(url)) return;
        seen.add(url);
        out.push(url);
    });
    return out;
}
function urlsFromFields(fields, kind){
    if(!fields || typeof fields !== 'object') return [];
    const out = [];
    Object.values(fields).forEach(value => {
        const url = normalizeRefUrl(value);
        if(!url) return;
        if(kind === 'video' && isVideoUrl(url)) out.push(url);
        if(kind === 'audio' && isAudioUrl(url)) out.push(url);
        if(kind === 'image' && isImageUrl(url) && !isVideoUrl(url) && !isAudioUrl(url)) out.push(url);
    });
    return out;
}
function collectReferenceImages(data){
    const refs = (data.params?.reference_images || []).filter(ref => normalizeRefUrl(ref));
    const fromFields = urlsFromFields(data.params?.fields, 'image').map(url => ({ url }));
    const merged = [...refs];
    const seen = new Set(refs.map(ref => normalizeRefUrl(ref)).filter(Boolean));
    fromFields.forEach(ref => {
        const url = normalizeRefUrl(ref);
        if(!url || seen.has(url)) return;
        seen.add(url);
        merged.push(ref);
    });
    return merged;
}
function collectReferenceVideos(data){
    return dedupeUrls([
        ...(data.params?.reference_videos || []),
        ...urlsFromFields(data.params?.fields, 'video'),
    ]);
}
function collectReferenceAudios(data){
    return dedupeUrls([
        ...(data.params?.reference_audios || []),
        ...urlsFromFields(data.params?.fields, 'audio'),
    ]);
}
function collectViewerParamRows(data){
    const rows = [];
    const params = data.params || {};
    const type = String(data.type || '').toLowerCase();
    if(type === 'runninghub'){
        const wf = data.workflow_name || data.workflow_id || params.workflow_id;
        if(wf) rows.push({ label: tr('online.viewerWorkflow') || 'Workflow', value: String(wf) });
    }
    if(type === 'local-comfy' && (data.workflow || params.workflow)){
        rows.push({ label: tr('online.viewerWorkflow') || 'Workflow', value: String(data.workflow || params.workflow) });
    }
    const refImageUrls = new Set(collectReferenceImages(data).map(ref => normalizeRefUrl(ref)));
    const refVideoUrls = new Set(collectReferenceVideos(data));
    const refAudioUrls = new Set(collectReferenceAudios(data));
    const fields = params.fields;
    const fieldsMeta = params.fields_meta || {};
    if(fields && typeof fields === 'object'){
        Object.entries(fields).forEach(([key, value]) => {
            const text = value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value)).trim();
            if(!text) return;
            if(refVideoUrls.has(text) || refAudioUrls.has(text) || refImageUrls.has(text)) return;
            if(isVideoUrl(text) || isAudioUrl(text) || isImageUrl(text)) return;
            const label = fieldsMeta[key]?.name || key;
            rows.push({ label, value: text.length > 160 ? `${text.slice(0, 160)}…` : text });
        });
    }
    if(type === 'local-comfy' && params && typeof params === 'object'){
        Object.entries(params).forEach(([key, value]) => {
            if(['reference_images', 'fields', 'fields_meta', 'workflow', 'imported', 'job_id', 'provider_id', 'model', 'size', 'quality'].includes(key)) return;
            if(value == null || typeof value === 'object') return;
            const text = String(value).trim();
            if(!text) return;
            rows.push({ label: key, value: text.length > 160 ? `${text.slice(0, 160)}…` : text });
        });
    }
    return rows;
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
        if(modelName !== '—') rows.push({ label: tr('online.model') || 'Model', value: modelName });
        if(size && size !== '—') rows.push({ label: tr('online.size') || 'Size', value: size });
        if(paramsQuality(data)) rows.push({ label: tr('online.quality') || 'Quality', value: paramsQuality(data) });
    }
    if(data.seed != null) rows.push({ label: 'Seed', value: String(data.seed) });
    rows.push({ label: tr('online.viewerCreated') || 'Created', value: formatViewerTime(data.timestamp) });

    if(kind === 'video' && !edited){
        if(data.params?.duration) rows.push({ label: tr('canvas.videoDuration') || 'Duration', value: String(data.params.duration) + 's' });
        if(data.params?.aspect_ratio) rows.push({ label: tr('canvas.videoAspect') || 'Aspect', value: data.params.aspect_ratio });
        if(data.params?.resolution) rows.push({ label: tr('canvas.videoResolution') || 'Resolution', value: data.params.resolution });
        if(data.params?.generate_audio) rows.push({ label: tr('online.viewerGenerateAudio') || 'Generated audio', value: '✓' });
    }
    if(kind === 'audio' && !edited && modelName !== '—') rows.push({ label: tr('online.model') || 'Model', value: modelName });
    if(data.params?.imported && !edited) rows.push({ label: tr('online.import') || 'Import', value: '✓' });
    return rows;
}
function paramsQuality(data){
    const q = data.params?.quality;
    if(!q || q === '—' || q === 'auto') return '';
    return String(q);
}
function renderRefMediaThumb(url, kind, name, extraHtml = ''){
    const safeUrl = escapeHtml(url);
    const safeName = escapeHtml(name || fileNameFromUrl(url));
    if(kind === 'image'){
        return `<button type="button" class="viewer-ref-thumb" data-ref-preview="${safeUrl}" data-ref-kind="image" title="${safeName}">
            <img src="${safeUrl}" alt="">
            ${extraHtml}
        </button>`;
    }
    if(kind === 'video'){
        return `<button type="button" class="viewer-ref-thumb viewer-ref-thumb-video" data-ref-preview="${safeUrl}" data-ref-kind="video" title="${safeName}">
            <video src="${safeUrl}" muted playsinline preload="metadata"></video>
            <span class="viewer-ref-type-badge"><i data-lucide="clapperboard"></i></span>
        </button>`;
    }
    return `<button type="button" class="viewer-ref-thumb viewer-ref-thumb-audio" data-ref-preview="${safeUrl}" data-ref-kind="audio" title="${safeName}">
        <span class="viewer-ref-audio-icon"><i data-lucide="music-2"></i></span>
    </button>`;
}
function renderRefImageThumbs(refs){
    return refs.map((ref, i) => {
        const url = normalizeRefUrl(ref);
        const role = String(ref?.role || '').trim();
        const name = ref?.name || fileNameFromUrl(url) || ('Ref ' + (i + 1));
        const roleHtml = role ? `<span class="viewer-ref-role">${escapeHtml(role)}</span>` : '';
        return renderRefMediaThumb(url, 'image', name, roleHtml);
    }).join('');
}
function renderRefVideoThumbs(urls){
    return urls.map(url => renderRefMediaThumb(url, 'video', fileNameFromUrl(url))).join('');
}
function renderRefAudioThumbs(urls){
    return urls.map(url => renderRefMediaThumb(url, 'audio', fileNameFromUrl(url))).join('');
}
function ensureViewerRefPreview(){
    if(document.getElementById('viewerRefPreview')) return;
    const wrap = document.createElement('div');
    wrap.id = 'viewerRefPreview';
    wrap.className = 'viewer-ref-preview hidden';
    wrap.innerHTML = `
        <div class="viewer-ref-preview-backdrop" onclick="closeViewerRefPreview()"></div>
        <div class="viewer-ref-preview-dialog" onclick="event.stopPropagation()">
            <button type="button" class="viewer-ref-preview-close" onclick="closeViewerRefPreview()" aria-label="Close"><i data-lucide="x"></i></button>
            <div id="viewerRefPreviewTitle" class="viewer-ref-preview-title"></div>
            <div id="viewerRefPreviewBody" class="viewer-ref-preview-body"></div>
        </div>
    `;
    document.getElementById('lightbox')?.appendChild(wrap);
}
function closeViewerRefPreview(){
    const overlay = document.getElementById('viewerRefPreview');
    if(!overlay) return;
    overlay.classList.add('hidden');
    const body = document.getElementById('viewerRefPreviewBody');
    if(body){
        body.querySelectorAll('video, audio').forEach(el => {
            try { el.pause(); } catch(e){}
            el.removeAttribute('src');
            el.load?.();
        });
        body.innerHTML = '';
    }
    const title = document.getElementById('viewerRefPreviewTitle');
    if(title) title.textContent = '';
}
function openViewerRefPreview(url, kind, name){
    const rawUrl = String(url || '').trim();
    if(!rawUrl) return;
    ensureViewerRefPreview();
    const overlay = document.getElementById('viewerRefPreview');
    const body = document.getElementById('viewerRefPreviewBody');
    const title = document.getElementById('viewerRefPreviewTitle');
    if(!overlay || !body) return;
    body.innerHTML = '';
    const mediaKind = String(kind || 'image').toLowerCase();
    if(mediaKind === 'video'){
        body.innerHTML = `<video src="${escapeHtml(rawUrl)}" controls autoplay playsinline class="viewer-ref-preview-video"></video>`;
    } else if(mediaKind === 'audio'){
        body.innerHTML = `<audio src="${escapeHtml(rawUrl)}" controls autoplay class="viewer-ref-preview-audio"></audio>`;
    } else {
        body.innerHTML = `<img src="${escapeHtml(rawUrl)}" alt="" class="viewer-ref-preview-image">`;
    }
    if(title) title.textContent = name || fileNameFromUrl(rawUrl);
    overlay.classList.remove('hidden');
    if(global.lucide && typeof global.lucide.createIcons === 'function') global.lucide.createIcons();
}
function bindViewerRefThumbEvents(container){
    if(!container || container.dataset.refBound) return;
    container.dataset.refBound = '1';
    container.addEventListener('click', e => {
        const btn = e.target.closest('[data-ref-preview]');
        if(!btn) return;
        e.preventDefault();
        e.stopPropagation();
        openViewerRefPreview(btn.dataset.refPreview, btn.dataset.refKind, btn.title || '');
    });
}
function renderViewerReferenceSections(data){
    const container = document.getElementById('viewerRefSections');
    if(!container) return;
    const imageRefs = collectReferenceImages(data);
    const videoRefs = collectReferenceVideos(data);
    const audioRefs = collectReferenceAudios(data);
    const blocks = [];
    if(imageRefs.length){
        blocks.push(`<div class="viewer-ref-section">
            <div class="viewer-block-title"><span>${escapeHtml(tr('online.referenceImages') || 'Reference Images')}</span></div>
            <div class="viewer-ref-thumbs">${renderRefImageThumbs(imageRefs)}</div>
        </div>`);
    }
    if(videoRefs.length){
        blocks.push(`<div class="viewer-ref-section">
            <div class="viewer-block-title"><span>${escapeHtml(tr('online.referenceVideos') || tr('video.referenceVideos') || 'Reference Videos')}</span></div>
            <div class="viewer-ref-thumbs">${renderRefVideoThumbs(videoRefs)}</div>
        </div>`);
    }
    if(audioRefs.length){
        blocks.push(`<div class="viewer-ref-section">
            <div class="viewer-block-title"><span>${escapeHtml(tr('online.referenceAudio') || tr('video.referenceAudio') || 'Reference Audio')}</span></div>
            <div class="viewer-ref-thumbs">${renderRefAudioThumbs(audioRefs)}</div>
        </div>`);
    }
    container.innerHTML = blocks.join('');
    container.classList.toggle('hidden', !blocks.length);
    bindViewerRefThumbEvents(container);
    if(global.lucide && typeof global.lucide.createIcons === 'function') global.lucide.createIcons();
}
function renderViewerExtraParams(data){
    const el = document.getElementById('viewerExtraParams');
    if(!el) return;
    const rows = collectViewerParamRows(data);
    if(!rows.length){
        el.classList.add('hidden');
        el.innerHTML = '';
        return;
    }
    el.classList.remove('hidden');
    el.innerHTML = `
        <div class="viewer-block-title"><span>${escapeHtml(tr('online.viewerParams') || 'Parameters')}</span></div>
        <div class="viewer-param-list">
            ${rows.map(row => `
                <div class="viewer-param-row">
                    <div class="viewer-param-label">${escapeHtml(row.label)}</div>
                    <div class="viewer-param-value">${escapeHtml(row.value)}</div>
                </div>
            `).join('')}
        </div>
    `;
}
function renderViewerRefThumbs(data){
    renderViewerReferenceSections(data);
    renderViewerExtraParams(data);
}
function renderViewerMetaGrid(container, rows){
    container.innerHTML = rows.map(row => `
        <div class="viewer-meta-cell">
            <div class="viewer-meta-label">${escapeHtml(row.label)}</div>
            <div class="viewer-meta-value">${escapeHtml(row.value)}</div>
        </div>
    `).join('');
}

const viewerEdit = {
    mode: 'brush',
    tool: 'draw',
    drawing: false,
    undoStack: [],
    lastPoint: null,
    cropDrag: null,
    cropRatio: '1:1',
    brushHue: 339,
    lastPointer: null,
    texts: [],
    selectedTextId: null,
    textUndoStack: [],
    textDrag: null,
    textSeq: 0,
    defaultTextFontRatio: 48,
};
const VIEWER_BRUSH_RATIO_MIN = 5;
const VIEWER_BRUSH_RATIO_MAX = 150;
const VIEWER_BRUSH_RATIO_DEFAULT = 16;
const VIEWER_TEXT_RATIO_MIN = 12;
const VIEWER_TEXT_RATIO_MAX = 180;
const VIEWER_TEXT_RATIO_DEFAULT = 48;

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
    if(!slider || viewerEdit.mode !== 'brush' || viewerEdit.tool !== 'draw') return;
    const next = Math.max(VIEWER_BRUSH_RATIO_MIN, Math.min(VIEWER_BRUSH_RATIO_MAX, Number(slider.value || VIEWER_BRUSH_RATIO_DEFAULT) + delta));
    if(next === Number(slider.value)) return;
    slider.value = String(next);
    syncViewerBrushSizeUI();
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    if(viewerEdit.lastPointer) updateViewerBrushCursor(viewerEdit.lastPointer);
}

function getViewerTextFontRatio(){
    const slider = document.getElementById('viewerTextSize');
    const raw = Number(slider?.value || viewerEdit.defaultTextFontRatio || VIEWER_TEXT_RATIO_DEFAULT);
    return Math.max(VIEWER_TEXT_RATIO_MIN, Math.min(VIEWER_TEXT_RATIO_MAX, raw));
}

function getViewerTextFontSizePx(ratio = getViewerTextFontRatio()){
    return Math.max(8, Math.round(getViewerImageMinDim() * (ratio / 1000)));
}

function syncViewerTextSizeUI(fromModel){
    const slider = document.getElementById('viewerTextSize');
    const valEl = document.getElementById('viewerTextSizeVal');
    if(!slider) return;
    let ratioVal = getViewerTextFontRatio();
    if(fromModel && viewerEdit.selectedTextId){
        const item = viewerEdit.texts.find(t => t.id === viewerEdit.selectedTextId);
        if(item){
            const minDim = getViewerImageMinDim();
            ratioVal = Math.max(VIEWER_TEXT_RATIO_MIN, Math.min(VIEWER_TEXT_RATIO_MAX, Math.round((item.fontSize / minDim) * 1000)));
            slider.value = String(ratioVal);
        }
    } else {
        slider.value = String(ratioVal);
    }
    viewerEdit.defaultTextFontRatio = ratioVal;
    if(valEl) valEl.textContent = `${(ratioVal / 10).toFixed(1)}%`;
}

function viewerTextSnapshot(){
    return {
        texts: viewerEdit.texts.map(t => ({ ...t })),
        selectedTextId: viewerEdit.selectedTextId,
        defaultTextFontRatio: viewerEdit.defaultTextFontRatio,
    };
}

function pushViewerTextUndo(){
    viewerEdit.textUndoStack.push(viewerTextSnapshot());
    if(viewerEdit.textUndoStack.length > 40) viewerEdit.textUndoStack.shift();
}

function clearViewerTexts(){
    viewerEdit.texts = [];
    viewerEdit.selectedTextId = null;
    viewerEdit.textUndoStack = [];
    viewerEdit.textDrag = null;
    const layer = document.getElementById('viewerTextLayer');
    if(layer) layer.innerHTML = '';
}

function layoutViewerTextLayer(){
    const img = document.getElementById('lightboxImg');
    const layer = document.getElementById('viewerTextLayer');
    if(!img || !layer || !img.complete || !img.naturalWidth) return false;
    const disp = getViewerImageDisplayRect(img);
    layer.style.left = `${disp.left}px`;
    layer.style.top = `${disp.top}px`;
    layer.style.width = `${disp.width}px`;
    layer.style.height = `${disp.height}px`;
    layer.style.right = 'auto';
    layer.style.bottom = 'auto';
    return true;
}

function viewerTextDisplayScale(){
    const img = document.getElementById('lightboxImg');
    const layer = document.getElementById('viewerTextLayer');
    if(!img?.naturalWidth || !layer) return 1;
    const w = parseFloat(layer.style.width) || layer.getBoundingClientRect().width || img.naturalWidth;
    return w / img.naturalWidth;
}

function renderViewerTextLayer(){
    const layer = document.getElementById('viewerTextLayer');
    if(!layer) return;
    layoutViewerTextLayer();
    const scale = viewerTextDisplayScale();
    const selectedId = viewerEdit.selectedTextId;
    layer.innerHTML = '';
    viewerEdit.texts.forEach(item => {
        const wrap = document.createElement('div');
        wrap.className = 'viewer-text-item' + (item.id === selectedId ? ' is-selected' : '');
        wrap.dataset.id = item.id;
        wrap.style.left = `${item.x * scale}px`;
        wrap.style.top = `${item.y * scale}px`;
        const content = document.createElement('div');
        content.className = 'viewer-text-content';
        content.contentEditable = viewerEdit.mode === 'brush' && viewerEdit.tool === 'text' ? 'true' : 'false';
        content.spellcheck = false;
        content.style.color = item.color || getViewerBrushColor();
        content.style.fontSize = `${Math.max(8, item.fontSize * scale)}px`;
        content.textContent = item.text || '';
        if(!item.text) content.dataset.placeholder = tr('online.viewerTextPlaceholder') || '输入文字';
        const handle = document.createElement('div');
        handle.className = 'viewer-text-handle';
        handle.dataset.role = 'scale';
        wrap.appendChild(content);
        wrap.appendChild(handle);
        layer.appendChild(wrap);
    });
}

function getViewerTextById(id){
    return viewerEdit.texts.find(t => t.id === id) || null;
}

function selectViewerText(id, { focus = false } = {}){
    viewerEdit.selectedTextId = id || null;
    renderViewerTextLayer();
    syncViewerTextSizeUI(true);
    const item = id ? getViewerTextById(id) : null;
    if(item?.color){
        // sync hue bar to text color approximately via hex if possible
        const hidden = document.getElementById('viewerBrushColor');
        if(hidden) hidden.value = item.color;
        const swatch = document.getElementById('viewerBrushColorSwatch');
        if(swatch) swatch.style.background = item.color;
        const thumb = document.getElementById('viewerHueThumb');
        if(thumb) thumb.style.background = item.color;
    }
    if(focus && id){
        requestAnimationFrame(() => {
            const el = document.querySelector(`.viewer-text-item[data-id="${CSS.escape(String(id))}"] .viewer-text-content`);
            if(!el) return;
            el.focus();
            const range = document.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
        });
    }
}

function createViewerTextAt(naturalX, naturalY){
    pushViewerTextUndo();
    const id = `t${Date.now()}_${++viewerEdit.textSeq}`;
    const fontSize = getViewerTextFontSizePx();
    const color = getViewerBrushColor();
    viewerEdit.texts.push({
        id,
        text: '',
        x: Math.max(0, naturalX),
        y: Math.max(0, naturalY),
        fontSize,
        color,
    });
    selectViewerText(id, { focus: true });
}

function syncViewerTextDomToModel(id){
    const item = getViewerTextById(id);
    const el = document.querySelector(`.viewer-text-item[data-id="${CSS.escape(String(id))}"] .viewer-text-content`);
    if(!item || !el) return;
    item.text = el.innerText.replace(/\u00a0/g, ' ');
}

function viewerHasEditableTexts(){
    return viewerEdit.texts.some(t => String(t.text || '').trim().length > 0);
}

function drawViewerTextsOnCanvas(ctx, width, height){
    if(!ctx || !viewerEdit.texts.length) return;
    viewerEdit.texts.forEach(item => {
        const text = String(item.text || '').replace(/\r\n/g, '\n');
        if(!text.trim()) return;
        const fontSize = Math.max(8, Number(item.fontSize) || 24);
        ctx.save();
        ctx.fillStyle = item.color || '#ff4d94';
        ctx.textBaseline = 'top';
        ctx.font = `700 ${fontSize}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.shadowColor = 'rgba(0,0,0,0.35)';
        ctx.shadowBlur = Math.max(1, fontSize * 0.04);
        ctx.shadowOffsetY = 1;
        const lines = text.split('\n');
        let y = Math.max(0, Math.min(height, item.y));
        const x = Math.max(0, Math.min(width, item.x));
        const lineHeight = fontSize * 1.25;
        lines.forEach(line => {
            ctx.fillText(line, x, y);
            y += lineHeight;
        });
        ctx.restore();
    });
}

function setViewerBrushTool(tool){
    const next = tool === 'text' ? 'text' : 'draw';
    viewerEdit.tool = next;
    document.getElementById('viewerToolDraw')?.classList.toggle('active', next === 'draw');
    document.getElementById('viewerToolText')?.classList.toggle('active', next === 'text');
    document.getElementById('viewerBrushSizeRow')?.classList.toggle('hidden', next !== 'draw');
    document.getElementById('viewerTextSizeRow')?.classList.toggle('hidden', next !== 'text');
    document.getElementById('viewerTextHint')?.classList.toggle('hidden', next !== 'text');
    const canvas = document.getElementById('viewerDrawCanvas');
    const layer = document.getElementById('viewerTextLayer');
    const inBrush = viewerEdit.mode === 'brush';
    canvas?.classList.toggle('viewer-draw-active', inBrush && next === 'draw');
    if(layer){
        layer.classList.toggle('hidden', !inBrush);
        layer.classList.toggle('viewer-text-active', inBrush && next === 'text');
        layer.setAttribute('aria-hidden', inBrush ? 'false' : 'true');
    }
    if(next === 'draw'){
        viewerEdit.selectedTextId = null;
        hideViewerBrushCursor();
    } else {
        hideViewerBrushCursor();
        if(!viewerEdit.textUndoStack.length) pushViewerTextUndo();
        syncViewerTextSizeUI(true);
    }
    renderViewerTextLayer();
    if(global.lucide) lucide.createIcons();
}

function undoViewerText(){
    if(viewerEdit.textUndoStack.length <= 1) return;
    viewerEdit.textUndoStack.pop();
    const prev = viewerEdit.textUndoStack[viewerEdit.textUndoStack.length - 1];
    if(!prev) return;
    viewerEdit.texts = (prev.texts || []).map(t => ({ ...t }));
    viewerEdit.selectedTextId = prev.selectedTextId || null;
    viewerEdit.defaultTextFontRatio = prev.defaultTextFontRatio || VIEWER_TEXT_RATIO_DEFAULT;
    renderViewerTextLayer();
    syncViewerTextSizeUI(true);
}

function applyViewerTextColorToSelected(color, { pushUndo = false } = {}){
    const item = getViewerTextById(viewerEdit.selectedTextId);
    if(!item || !color) return;
    if(pushUndo) pushViewerTextUndo();
    item.color = color;
    const el = document.querySelector(`.viewer-text-item[data-id="${CSS.escape(String(item.id))}"] .viewer-text-content`);
    if(el) el.style.color = color;
}

function applyViewerTextSizeToSelected(ratio, { pushUndo = false } = {}){
    const item = getViewerTextById(viewerEdit.selectedTextId);
    const fontSize = getViewerTextFontSizePx(ratio);
    viewerEdit.defaultTextFontRatio = ratio;
    if(!item) return;
    if(pushUndo) pushViewerTextUndo();
    item.fontSize = fontSize;
    renderViewerTextLayer();
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

function applyViewerBrushColorUI(color, { hue = null, showThumb = true } = {}){
    const hidden = document.getElementById('viewerBrushColor');
    const thumb = document.getElementById('viewerHueThumb');
    const bar = document.getElementById('viewerHueBar');
    const swatch = document.getElementById('viewerBrushColorSwatch');
    const cursor = document.getElementById('viewerBrushCursor');
    if(hidden) hidden.value = color;
    if(thumb){
        if(hue != null) thumb.style.left = `${(((Number(hue) % 360) + 360) % 360 / 360) * 100}%`;
        thumb.style.background = color;
        thumb.style.opacity = showThumb ? '1' : '0.35';
    }
    if(swatch) swatch.style.background = color;
    if(bar && hue != null) bar.setAttribute('aria-valuenow', String(Math.round(((Number(hue) % 360) + 360) % 360)));
    if(cursor) cursor.style.borderColor = color;
}

function setViewerBrushHue(hue, { applyText = true } = {}){
    const nextHue = ((Number(hue) % 360) + 360) % 360;
    viewerEdit.brushHue = nextHue;
    const color = viewerBrushColorFromHue(nextHue);
    applyViewerBrushColorUI(color, { hue: nextHue, showThumb: true });
    if(applyText && viewerEdit.mode === 'brush' && viewerEdit.tool === 'text' && viewerEdit.selectedTextId){
        applyViewerTextColorToSelected(color, { pushUndo: false });
    }
}

function setViewerBrushColor(color, { applyText = true, pushUndo = true } = {}){
    const next = String(color || '').trim();
    if(!/^#[0-9a-fA-F]{6}$/.test(next)) return;
    if(applyText && pushUndo && viewerEdit.mode === 'brush' && viewerEdit.tool === 'text' && viewerEdit.selectedTextId){
        pushViewerTextUndo();
    }
    applyViewerBrushColorUI(next, { hue: viewerEdit.brushHue, showThumb: false });
    if(applyText && viewerEdit.mode === 'brush' && viewerEdit.tool === 'text' && viewerEdit.selectedTextId){
        applyViewerTextColorToSelected(next, { pushUndo: false });
    }
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
        if(viewerEdit.mode === 'brush' && viewerEdit.tool === 'text' && viewerEdit.selectedTextId){
            pushViewerTextUndo();
        }
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
    setViewerBrushHue(viewerEdit.brushHue ?? 339, { applyText: false });
}

function updateViewerBrushCursor(e){
    const cursor = document.getElementById('viewerBrushCursor');
    const canvas = document.getElementById('viewerDrawCanvas');
    const stage = document.getElementById('viewerStage');
    if(viewerEdit.mode !== 'brush' || viewerEdit.tool !== 'draw' || !cursor || !canvas || !stage){
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
    const textLayer = document.getElementById('viewerTextLayer');
    canvas?.classList.toggle('viewer-draw-active', mode === 'brush' && viewerEdit.tool === 'draw');
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

    if(mode !== 'brush'){
        clearViewerTexts();
        textLayer?.classList.add('hidden');
        textLayer?.classList.remove('viewer-text-active');
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
        setViewerBrushTool(viewerEdit.tool || 'draw');
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
    clearViewerTexts();
    if(viewerEdit.mode === 'brush') setViewerBrushTool(viewerEdit.tool || 'draw');
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
        layoutViewerTextLayer();
        resetViewerDrawCanvas();
        syncViewerBrushSizeUI();
        syncViewerTextSizeUI();
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
    if(viewerEdit.mode === 'brush' && viewerEdit.tool === 'text'){
        undoViewerText();
        return;
    }
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
    if(viewerEdit.mode !== 'brush' || viewerEdit.tool !== 'draw') return;
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
    if(viewerEdit.selectedTextId) syncViewerTextDomToModel(viewerEdit.selectedTextId);
    viewerEdit.texts.forEach(t => syncViewerTextDomToModel(t.id));
    const merged = document.createElement('canvas');
    merged.width = img.naturalWidth;
    merged.height = img.naturalHeight;
    const ctx = merged.getContext('2d');
    ctx.drawImage(img, 0, 0);
    if(drawCanvas?.width) ctx.drawImage(drawCanvas, 0, 0);
    drawViewerTextsOnCanvas(ctx, merged.width, merged.height);
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

async function importVideoFrameCanvas(canvas, source, captureTimeSec){
    if(!canvas || !source) return null;
    let blob;
    try {
        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    } catch(e){
        throw new Error('Capture failed');
    }
    if(!blob) throw new Error('Capture failed');
    const file = new File([blob], `video_frame_${Date.now()}.png`, { type: 'image/png' });
    const form = new FormData();
    form.append('files', file);
    const res = await fetch('/api/online-import', { method:'POST', body: form });
    if(!res.ok) throw new Error('Import failed');
    const data = await res.json();
    const timeLabel = Number.isFinite(captureTimeSec) ? `${Math.max(0, captureTimeSec).toFixed(2)}s` : '';
    const frameNote = tr('viewer.videoFrameAt') || 'Video frame';
    const basePrompt = String(source.prompt || '').trim();
    const items = (data.items || []).map(item => ({
        ...item,
        prompt: basePrompt
            ? `${basePrompt} (${frameNote}${timeLabel ? ` ${timeLabel}` : ''})`
            : `${frameNote}${timeLabel ? ` ${timeLabel}` : ''}`,
        model: source.model || source.params?.model || item.model || '',
        provider_id: source.provider_id || source.params?.provider_id || item.provider_id || '',
        provider_name: source.provider_name || item.provider_name || '',
        params: {
            ...(source.params || {}),
            imported: true,
            video_frame_capture: true,
            captured_from: historyKey(source),
            capture_time_sec: captureTimeSec,
            source_video_url: mediaUrl(source),
            reference_images: source.params?.reference_images || []
        }
    }));
    items.forEach(item => { if(opts.onUpsertItem) opts.onUpsertItem(item); });
    if(opts.onRefresh) opts.onRefresh();
    return items[0] || null;
}

async function captureViewerVideoFrame(ev){
    ev?.stopPropagation();
    const video = document.getElementById('viewerVideoEl');
    const source = currentLightboxData;
    const btn = document.getElementById('viewerCaptureFrameBtn');
    if(!video || !source || getMediaKind(source) !== 'video') return;
    if(video.readyState < 2){
        alert(tr('viewer.captureFrameNotReady') || 'Video is not ready yet.');
        return;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    if(!w || !h){
        alert(tr('viewer.captureFrameNotReady') || 'Video is not ready yet.');
        return;
    }
    if(btn) btn.disabled = true;
    try {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);
        await importVideoFrameCanvas(canvas, source, video.currentTime);
    } catch(err){
        console.error(err);
        alert(tr('viewer.captureFrameFailed') || 'Failed to capture video frame.');
    } finally {
        if(btn) btn.disabled = false;
        if(global.lucide) lucide.createIcons();
    }
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
            const hasStrokes = viewerDrawCanvasHasStrokes();
            const hasText = viewerHasEditableTexts();
            if(!hasStrokes && !hasText){
                alert(tr('online.viewerNoEdit') || '请先在图片上涂抹');
                return;
            }
            const merged = await getViewerMergedCanvas();
            if(!merged) return;
            newItem = await importEditedViewerCanvas(merged, hasText && !hasStrokes ? 'text' : 'brush');
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

function viewerTextLayerPoint(e){
    const layer = document.getElementById('viewerTextLayer');
    const img = document.getElementById('lightboxImg');
    if(!layer || !img?.naturalWidth) return null;
    const rect = layer.getBoundingClientRect();
    const scale = rect.width / img.naturalWidth;
    if(scale <= 0) return null;
    return {
        x: (e.clientX - rect.left) / scale,
        y: (e.clientY - rect.top) / scale,
        scale,
        displayX: e.clientX - rect.left,
        displayY: e.clientY - rect.top,
    };
}

function beginViewerTextPointer(e){
    if(viewerEdit.mode !== 'brush' || viewerEdit.tool !== 'text') return;
    const layer = document.getElementById('viewerTextLayer');
    if(!layer || !layer.contains(e.target)) return;
    const itemEl = e.target.closest('.viewer-text-item');
    const handle = e.target.closest('.viewer-text-handle');
    const content = e.target.closest('.viewer-text-content');
    if(itemEl){
        const id = itemEl.dataset.id;
        if(viewerEdit.selectedTextId && viewerEdit.selectedTextId !== id){
            syncViewerTextDomToModel(viewerEdit.selectedTextId);
        }
        if(handle){
            e.preventDefault();
            e.stopPropagation();
            const item = getViewerTextById(id);
            if(!item) return;
            pushViewerTextUndo();
            selectViewerText(id);
            viewerEdit.textDrag = {
                kind: 'scale',
                id,
                startX: e.clientX,
                startY: e.clientY,
                startFontSize: item.fontSize,
            };
            window.addEventListener('pointermove', moveViewerTextPointer);
            window.addEventListener('pointerup', endViewerTextPointer, { once: true });
            return;
        }
        if(content && viewerEdit.selectedTextId === id){
            // allow caret placement / typing in already-selected text
            return;
        }
        e.preventDefault();
        selectViewerText(id, { focus: !!content });
        const item = getViewerTextById(id);
        if(!item) return;
        pushViewerTextUndo();
        viewerEdit.textDrag = {
            kind: 'move',
            id,
            startX: e.clientX,
            startY: e.clientY,
            originX: item.x,
            originY: item.y,
            moved: false,
        };
        window.addEventListener('pointermove', moveViewerTextPointer);
        window.addEventListener('pointerup', endViewerTextPointer, { once: true });
        return;
    }
    // blank area → create text
    const pt = viewerTextLayerPoint(e);
    if(!pt) return;
    e.preventDefault();
    if(viewerEdit.selectedTextId) syncViewerTextDomToModel(viewerEdit.selectedTextId);
    createViewerTextAt(pt.x, pt.y);
}

function moveViewerTextPointer(e){
    const drag = viewerEdit.textDrag;
    if(!drag) return;
    const item = getViewerTextById(drag.id);
    const scale = viewerTextDisplayScale();
    if(!item || scale <= 0) return;
    if(drag.kind === 'move'){
        const dx = (e.clientX - drag.startX) / scale;
        const dy = (e.clientY - drag.startY) / scale;
        if(Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
        item.x = Math.max(0, drag.originX + dx);
        item.y = Math.max(0, drag.originY + dy);
        const wrap = document.querySelector(`.viewer-text-item[data-id="${CSS.escape(String(drag.id))}"]`);
        if(wrap){
            wrap.style.left = `${item.x * scale}px`;
            wrap.style.top = `${item.y * scale}px`;
        }
        return;
    }
    if(drag.kind === 'scale'){
        const dy = e.clientY - drag.startY;
        const dx = e.clientX - drag.startX;
        const delta = (dx + dy) / 2 / scale;
        item.fontSize = Math.max(8, Math.round(drag.startFontSize + delta));
        const minDim = getViewerImageMinDim();
        const ratio = Math.max(VIEWER_TEXT_RATIO_MIN, Math.min(VIEWER_TEXT_RATIO_MAX, Math.round((item.fontSize / minDim) * 1000)));
        const slider = document.getElementById('viewerTextSize');
        if(slider) slider.value = String(ratio);
        syncViewerTextSizeUI();
        const content = document.querySelector(`.viewer-text-item[data-id="${CSS.escape(String(drag.id))}"] .viewer-text-content`);
        if(content) content.style.fontSize = `${Math.max(8, item.fontSize * scale)}px`;
    }
}

function endViewerTextPointer(e){
    const drag = viewerEdit.textDrag;
    window.removeEventListener('pointermove', moveViewerTextPointer);
    if(!drag) return;
    if(drag.kind === 'move' && !drag.moved){
        // treat as click-to-focus
        selectViewerText(drag.id, { focus: true });
    } else {
        renderViewerTextLayer();
        syncViewerTextSizeUI(true);
    }
    viewerEdit.textDrag = null;
}

function bindViewerTextLayer(){
    const layer = document.getElementById('viewerTextLayer');
    if(!layer || layer.dataset.bound) return;
    layer.dataset.bound = '1';
    layer.addEventListener('pointerdown', beginViewerTextPointer);
    layer.addEventListener('input', e => {
        const content = e.target.closest?.('.viewer-text-content');
        const itemEl = content?.closest('.viewer-text-item');
        if(!itemEl) return;
        const id = itemEl.dataset.id;
        const item = getViewerTextById(id);
        if(!item) return;
        if(!viewerEdit._textTypingUndo){
            pushViewerTextUndo();
            viewerEdit._textTypingUndo = true;
        }
        item.text = content.innerText.replace(/\u00a0/g, ' ');
    });
    layer.addEventListener('focusout', e => {
        if(!layer.contains(e.relatedTarget)) viewerEdit._textTypingUndo = false;
        const content = e.target.closest?.('.viewer-text-content');
        const itemEl = content?.closest('.viewer-text-item');
        if(itemEl) syncViewerTextDomToModel(itemEl.dataset.id);
    });
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
    bindViewerTextLayer();
    syncViewerBrushSizeUI();
    syncViewerTextSizeUI();
    document.getElementById('viewerBrushSize')?.addEventListener('input', () => {
        syncViewerBrushSizeUI();
        const evt = viewerEdit.lastPointer;
        if(evt) updateViewerBrushCursor(evt);
    });
    let textSizeUndoArmed = false;
    document.getElementById('viewerTextSize')?.addEventListener('pointerdown', () => {
        if(viewerEdit.selectedTextId){
            pushViewerTextUndo();
            textSizeUndoArmed = true;
        }
    });
    document.getElementById('viewerTextSize')?.addEventListener('input', () => {
        syncViewerTextSizeUI();
        applyViewerTextSizeToSelected(getViewerTextFontRatio(), { pushUndo: false });
    });
    document.getElementById('viewerTextSize')?.addEventListener('change', () => { textSizeUndoArmed = false; });
    document.getElementById('viewerStage')?.addEventListener('pointermove', e => {
        viewerEdit.lastPointer = e;
        updateViewerBrushCursor(e);
    });
    document.getElementById('viewerStage')?.addEventListener('wheel', e => {
        if(viewerEdit.mode !== 'brush' || viewerEdit.tool !== 'draw') return;
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
    if(global.lucide && typeof global.lucide.createIcons === 'function') global.lucide.createIcons();
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
    closeViewerRefPreview();
    document.getElementById('lightbox').classList.remove('open');
    document.body.style.overflow = '';
    lightboxIndex = -1;
    viewerEdit.drawing = false;
    viewerEdit.cropDrag = null;
    viewerEdit.textDrag = null;
    clearViewerTexts();
    viewerEdit.tool = 'draw';
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
        if(global.downloadStudioAsset){
            await global.downloadStudioAsset(url, url.split('/').pop() || 'media');
            return;
        }
        const link = document.createElement('a');
        link.href = url;
        link.download = url.split('/').pop() || 'media';
        document.body.appendChild(link);
        link.click();
        link.remove();
        return;
    }
    const merged = await getViewerMergedCanvas();
    if(merged){
        try {
            const link = document.createElement('a');
            link.href = merged.toDataURL('image/png');
            link.download = `studio-image-${Date.now()}.png`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            return;
        } catch (_) {}
    }
    const url = data?.images?.[0];
    if(url && global.downloadStudioAsset){
        await global.downloadStudioAsset(url, `studio-image-${Date.now()}.png`);
    }
}
function bindViewerGlobals(){
  global.viewerNav = viewerNav;
  global.closeLightbox = closeLightbox;
  global.handleOutsideClick = handleOutsideClick;
  global.copyLightboxPrompt = copyLightboxPrompt;
  global.copyLightboxImage = copyLightboxImage;
  global.downloadLightboxImage = downloadLightboxImage;
  global.captureViewerVideoFrame = captureViewerVideoFrame;
  global.openLightboxFullscreen = openLightboxFullscreen;
  global.toggleViewerFavorite = toggleViewerFavorite;
  global.toggleViewerPin = toggleViewerPin;
  global.setViewerEditMode = setViewerEditMode;
  global.setViewerBrushTool = setViewerBrushTool;
  global.setViewerBrushColor = setViewerBrushColor;
  global.undoViewerDraw = undoViewerDraw;
  global.confirmViewerEdit = confirmViewerEdit;
  global.setViewerCropRatio = setViewerCropRatio;
  global.applySameStyle = applySameStyle;
  global.applyViewerGridPreset = applyViewerGridPreset;
  global.refreshViewerGridSplitPreview = refreshViewerGridSplitPreview;
  global.syncViewerBrushSizeUI = syncViewerBrushSizeUI;
  global.syncViewerTextSizeUI = syncViewerTextSizeUI;
  global.openViewerRefPreview = openViewerRefPreview;
  global.closeViewerRefPreview = closeViewerRefPreview;
  if(!global._studioViewerKeyBound){
    global._studioViewerKeyBound = true;
    document.addEventListener('keydown', e => {
      const open = document.getElementById('lightbox')?.classList.contains('open');
      if(!open) return;
      const typing = e.target?.closest?.('.viewer-text-content');
      if(e.key === 'Escape'){
        const refOpen = !document.getElementById('viewerRefPreview')?.classList.contains('hidden');
        if(refOpen){ closeViewerRefPreview(); return; }
        if(typing || viewerEdit.selectedTextId){
          if(viewerEdit.selectedTextId) syncViewerTextDomToModel(viewerEdit.selectedTextId);
          viewerEdit.selectedTextId = null;
          renderViewerTextLayer();
          if(typing) typing.blur();
          return;
        }
        closeLightbox();
      }
      if(typing) return;
      if(e.key === 'ArrowLeft') viewerNav(-1);
      if(e.key === 'ArrowRight') viewerNav(1);
      if((e.key === 'Delete' || e.key === 'Backspace') && viewerEdit.mode === 'brush' && viewerEdit.tool === 'text' && viewerEdit.selectedTextId){
        e.preventDefault();
        pushViewerTextUndo();
        viewerEdit.texts = viewerEdit.texts.filter(t => t.id !== viewerEdit.selectedTextId);
        viewerEdit.selectedTextId = null;
        renderViewerTextLayer();
      }
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
