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

                error: job.error || null,

                task_id: job.task_id || null

            })

        }).catch(e => console.error('Register pending job failed:', e));

    };



    window.updatePendingJobOnServer = function(jobId, patch) {

        if(!jobId) return;

        fetch('/api/online-pending/' + encodeURIComponent(jobId), {

            method: 'PATCH',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify(patch || {})

        }).catch(e => console.error('Update pending job failed:', e));

    };



    window.deletePendingJobOnServer = function(jobId) {

        fetch('/api/online-pending/' + encodeURIComponent(jobId), {

            method: 'DELETE'

        }).catch(e => console.error('Delete pending job failed:', e));

    };



    window.pollCanvasImageTask = async function(taskId, options = {}) {

        const interval = Number(options.interval) || 2000;

        const timeout = Number(options.timeout) || 600000;

        const started = Date.now();

        while(Date.now() - started < timeout){

            const res = await fetch('/api/canvas-image-tasks/' + encodeURIComponent(taskId));

            if(res.status === 404) throw new Error('Task not found');

            const task = await res.json();

            if(task.status === 'succeeded') return task.result;

            if(task.status === 'failed') throw new Error(task.error || 'Generation failed');

            await new Promise(resolve => setTimeout(resolve, interval));

        }

        throw new Error('Generation timed out');

    };

    window.pollCanvasVideoTask = async function(taskId, options = {}) {

        const interval = Number(options.interval) || 2000;

        const timeout = Number(options.timeout) || 1800000;

        const started = Date.now();

        while(Date.now() - started < timeout){

            const res = await fetch('/api/canvas-video-tasks/' + encodeURIComponent(taskId));

            if(res.status === 404) throw new Error('Task not found');

            const task = await res.json();

            if(task.status === 'succeeded') return task.result;

            if(task.status === 'failed') throw new Error(task.error || 'Generation failed');

            await new Promise(resolve => setTimeout(resolve, interval));

        }

        throw new Error('Generation timed out');

    };

    window.pollCanvasRunningHubTask = async function(taskId, options = {}) {

        const interval = Number(options.interval) || 30000;

        const timeout = Number(options.timeout) || 1200000;

        const started = Date.now();

        while(Date.now() - started < timeout){

            const res = await fetch('/api/canvas-runninghub-tasks/' + encodeURIComponent(taskId));

            if(res.status === 404) throw new Error('Task not found');

            const task = await res.json();

            if(task.status === 'succeeded') return task.result;

            if(task.status === 'failed') throw new Error(task.error || 'Generation failed');

            await new Promise(resolve => setTimeout(resolve, interval));

        }

        throw new Error('Generation timed out');

    };

    window.pollCanvasComfyTask = async function(taskId, options = {}) {

        const interval = Number(options.interval) || 2000;

        const timeout = Number(options.timeout) || 1860000;

        const started = Date.now();

        while(Date.now() - started < timeout){

            const res = await fetch('/api/canvas-comfy-tasks/' + encodeURIComponent(taskId));

            if(res.status === 404) throw new Error('Task not found');

            const task = await res.json();

            if(task.status === 'succeeded') return task.result;

            if(task.status === 'failed') throw new Error(task.error || 'Generation failed');

            await new Promise(resolve => setTimeout(resolve, interval));

        }

        throw new Error('Generation timed out');

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

        notifyPending(jobs){ channel.postMessage({ type:'gallery-set-pending', jobs: jobs || [], pageType: StudioPanelBridge.pageType }); },

        notifyBoardPick(slotId){ channel.postMessage({ type:'gallery-board-pick', slotId: slotId || '' }); },

    };



    function handleGalleryApplyParams(item){

        if(!item) return;

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

            Promise.resolve(window.applyRecordParams(item, null)).catch(err => console.error('applyRecordParams failed:', err));

        }

    }



    channel.onmessage = (event) => {

        const data = event.data || {};

        if(data.type === 'gallery-apply-params'){

            handleGalleryApplyParams(data.item);

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



    window.addEventListener('message', (event) => {

        const data = event.data || {};

        if(data.type === 'gallery-apply-params'){

            handleGalleryApplyParams(data.item);

        }

    });



    window.addEventListener('DOMContentLoaded', () => {

        document.body?.classList.add('embed-panel');

        StudioPanelBridge.notifyRefresh();

    });

})();

