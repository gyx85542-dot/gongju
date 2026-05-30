(function(){
    window.registerPendingJobOnServer = function(job) {
        fetch('/api/online-pending', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: job.id,
                prompt: job.prompt || '',
                mediaKind: job.mediaKind || 'image',
                timestamp: job.timestamp || (Date.now() / 1000),
                error: job.error || null
            })
        }).catch(e => console.error('Register pending job failed:', e));
    };

    window.deletePendingJobOnServer = function(jobId) {
        fetch('/api/online-pending/' + encodeURIComponent(jobId), {
            method: 'DELETE'
        }).catch(e => console.error('Delete pending job failed:', e));
    };

    const EMBED_PANEL = new URLSearchParams(location.search).get('embed') === 'panel';
    if(!EMBED_PANEL) return;

    document.documentElement.classList.add('embed-panel');
    const channel = new BroadcastChannel('studio-gallery');

    window.StudioPanelBridge = {
        channel,
        pageType: new URLSearchParams(location.search).get('page') || 'online',
        notifyRefresh(){ channel.postMessage({ type:'gallery-refresh' }); },
        notifyAddItem(item){ channel.postMessage({ type:'gallery-add-item', item }); },
        notifyPending(jobs){ channel.postMessage({ type:'gallery-set-pending', jobs: jobs || [] }); },
        notifyBoardPick(slotId){ channel.postMessage({ type:'gallery-board-pick', slotId: slotId || '' }); },
    };

    channel.onmessage = (event) => {
        const data = event.data || {};
        if(data.type === 'gallery-apply-params'){
            const item = data.item;
            const target = window.StudioHistoryMeta?.studioPageForHistoryType
                ? StudioHistoryMeta.studioPageForHistoryType(item?.type)
                : (String(item?.type || '').toLowerCase() === 'runninghub' ? 'runninghub'
                    : String(item?.type || '').toLowerCase() === 'local-comfy' ? 'local'
                    : (['online-video', 'online-audio'].includes(String(item?.type || '').toLowerCase()) ? 'video' : 'online'));
            if(StudioPanelBridge.pageType !== target){
                try { window.parent.postMessage({ type: 'studio-apply-params', item }, '*'); } catch(err) {}
                return;
            }
            if(typeof window.applyRecordParams === 'function'){
                window.applyRecordParams(item, null);
            }
        }
        if(data.type === 'gallery-board-select' && data.url){
            const slotId = window.boardPickSlotId;
            if(typeof window.handleImageUrl === 'function' && slotId){
                Promise.resolve(window.handleImageUrl(data.url, slotId)).finally(() => {
                    if(typeof window.cancelBoardPick === 'function') window.cancelBoardPick();
                });
            } else if(typeof window.cancelBoardPick === 'function'){
                window.cancelBoardPick();
            }
        }
        if(data.type === 'gallery-board-pick-exit' && typeof window.cancelBoardPick === 'function'){
            window.cancelBoardPick();
        }
    };

    window.addEventListener('DOMContentLoaded', () => {
        document.body?.classList.add('embed-panel');
        StudioPanelBridge.notifyRefresh();
    });
})();
