/**
 * Studio 媒体下载：本地路径直连，远程 URL 经 /api/download-output 代理。
 */
(function (global) {
    'use strict';

    function isLocalStudioUrl(url) {
        const u = String(url || '').trim();
        return u.startsWith('/output/') || u.startsWith('/assets/');
    }

    async function downloadStudioAsset(url, filename) {
        const clean = String(url || '').trim();
        if (!clean) return;
        const fname =
            filename || clean.split('/').pop().split('?')[0] || 'download.png';
        const href = `/api/download-output?url=${encodeURIComponent(clean)}&name=${encodeURIComponent(fname)}`;
        try {
            if (isLocalStudioUrl(clean)) {
                const link = document.createElement('a');
                link.href = href;
                link.download = fname;
                document.body.appendChild(link);
                link.click();
                link.remove();
                return;
            }
            const res = await fetch(href);
            if (!res.ok) {
                const payload = await res.json().catch(() => ({}));
                const detail = payload && payload.detail;
                throw new Error(
                    typeof detail === 'string' && detail.trim()
                        ? detail
                        : '下载失败'
                );
            }
            const blob = await res.blob();
            const blobUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = fname;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(blobUrl);
        } catch (err) {
            alert(err && err.message ? err.message : '下载失败');
        }
    }

    global.downloadStudioAsset = downloadStudioAsset;
})(window);
