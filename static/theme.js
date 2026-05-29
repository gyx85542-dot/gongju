(function(){
    const KEY = 'studio_theme';
    const LEGACY_KEY = 'canvas_theme';

    function applyTheme(){
        document.documentElement.classList.remove('studio-theme-dark', 'theme-dark');
        if(document.body){
            document.body.classList.remove('studio-theme-dark', 'theme-dark');
        }
        window.dispatchEvent(new CustomEvent('studio-theme-change', { detail: { theme: 'light' } }));
    }

    window.StudioTheme = {
        key: KEY,
        get: () => 'light',
        apply: applyTheme,
        set(){
            localStorage.setItem(KEY, 'light');
            localStorage.setItem(LEGACY_KEY, 'light');
            applyTheme();
        }
    };

    localStorage.setItem(KEY, 'light');
    localStorage.setItem(LEGACY_KEY, 'light');
    applyTheme();

    document.addEventListener('DOMContentLoaded', applyTheme);
    window.addEventListener('message', event => {
        if(event.data?.type === 'studio-theme') applyTheme();
    });
    window.addEventListener('storage', event => {
        if(event.key === KEY || event.key === LEGACY_KEY) applyTheme();
    });
})();
