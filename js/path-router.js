/* Fallback tombol kembali cerdas (auth-client.js dihapus — tanpa gate login) */
window.ClincooBack = window.ClincooBack || function (fallbackUrl) {
            try {
                var sameOrigin = document.referrer && new URL(document.referrer).origin === location.origin;
                if (sameOrigin && history.length > 1) { window.history.back(); return; }
            } catch (e) {}
            if (fallbackUrl) { try { location.replace(fallbackUrl); return; } catch (e2) {} }
            try { window.history.back(); } catch (e3) {}
        };
/**
 * Clincoo URL Path Router
 * Parses nested URLs like /workspace/{projectId}/pengaturan/{submenu}
 * Supports both Cloudflare Pages (root) and GitHub Pages (subpath /Clincoo/)
 */

// Detect if we're on GitHub Pages (subpath) vs Cloudflare Pages (root)
var _seg = window.location.pathname.split('/')[1] || '';
var _known = ['akun','proyek','auth','templates','integrasi','assets','js','demo','sw.js','manifest.json','robots.txt','_redirects','index.html','404.html'];
var _isGitHubPages = window.location.hostname.indexOf('github.io') !== -1;
var _BASE = _isGitHubPages && _seg && _known.indexOf(_seg) === -1 ? '/' + _seg : '';

const PathRouter = {
    getSegments() {
        let path = window.location.pathname.replace(/\.html$/, '');
        // Remove base path for segment parsing
        if (_BASE && path.startsWith(_BASE)) {
            path = path.substring(_BASE.length);
        }
        return path.split('/').filter(s => s.length > 0);
    },

    getProjectId() {
        const segments = this.getSegments();
        if (segments.length >= 2 && segments[0] === 'workspace') {
            return decodeURIComponent(segments[1]);
        }
        const params = new URLSearchParams(window.location.search);
        return params.get('id') || null;
    },

    getSection() {
        const segments = this.getSegments();
        if (segments.length >= 3 && segments[0] === 'workspace') {
            return segments[2];
        }
        return null;
    },

    getSubmenu() {
        const segments = this.getSegments();
        if (segments.length >= 4 && segments[0] === 'workspace') {
            return segments[3];
        }
        return null;
    },

    getProfileSection() {
        const segments = this.getSegments();
        if (segments.length >= 2 && segments[0] === 'profil') {
            return segments[1];
        }
        return null;
    },

    buildProjectUrl(subpath) {
        const projectId = this.getProjectId() || localStorage.getItem('clincoo_current_project_id');
        if (!projectId) return _BASE + '/';
        if (_isGitHubPages) {
            // GitHub Pages: use pages/xxx.html?id=projectId
            if (subpath) {
                return _BASE + '/proyek/' + subpath + '/?id=' + encodeURIComponent(projectId);
            }
            return _BASE + '/proyek/workspace/?id=' + encodeURIComponent(projectId);
        }
        // Cloudflare Pages: clean URLs
        return _BASE + '/workspace/' + projectId + (subpath ? '/' + subpath : '');
    },

    navigate(subpath) {
        window.location.href = this.buildProjectUrl(subpath);
    },

    goBack() {
        const segments = this.getSegments();
        if (segments[0] === 'workspace') {
            if (segments.length >= 4) {
                if (_isGitHubPages) {
                    const pid = this.getProjectId();
                    window.ClincooBack(_BASE + '/proyek/' + segments[2] + '/?id=' + encodeURIComponent(pid));
                } else {
                    window.ClincooBack(_BASE + '/' + segments.slice(0, 3).join('/'));
                }
            } else if (segments.length >= 3) {
                if (_isGitHubPages) {
                    const pid = this.getProjectId();
                    window.ClincooBack(_BASE + '/proyek/workspace.html?id=' + encodeURIComponent(pid));
                } else {
                    window.ClincooBack(_BASE + '/' + segments.slice(0, 2).join('/'));
                }
            } else if (segments.length >= 2) {
                window.ClincooBack(_BASE + '/');
            } else {
                window.history.back();
            }
        } else if (segments[0] === 'profil') {
            if (segments.length >= 2) {
                if (_isGitHubPages) {
                    window.ClincooBack(_BASE + '/akun/profile/');
                } else {
                    window.ClincooBack(_BASE + '/profil');
                }
            } else {
                window.ClincooBack(_BASE + '/');
            }
        } else {
            window.history.back();
        }
    },

    persistProjectId() {
        const id = this.getProjectId();
        if (id) {
            try { localStorage.setItem('clincoo_current_project_id', id); } catch(e) {}
        }
    },

    getProjectIdWithFallback() {
        let id = this.getProjectId();
        if (!id) {
            try { id = localStorage.getItem('clincoo_current_project_id'); } catch(e) {}
        }
        return id;
    },

    /**
     * Patch sidebar nav links to include the current project_id
     */
    patchSidebarLinks() {
        const projectId = this.getProjectIdWithFallback();
        if (!projectId) return;

        let linkMap;
        if (_isGitHubPages) {
            linkMap = {
                'workspace': _BASE + '/proyek/workspace/?id=' + encodeURIComponent(projectId),
                'chat': _BASE + '/proyek/chat/?id=' + encodeURIComponent(projectId),
                'pengaturan': _BASE + '/proyek/dashboard/?id=' + encodeURIComponent(projectId),
                'environment': _BASE + '/proyek/pengaturan/environment/?id=' + encodeURIComponent(projectId),
                'keamanan': _BASE + '/proyek/pengaturan/keamanan/?id=' + encodeURIComponent(projectId),
            };
        } else {
            linkMap = {
                'workspace': _BASE + '/workspace/' + projectId,
                'chat': _BASE + '/workspace/' + projectId + '/chat',
                'pengaturan': _BASE + '/workspace/' + projectId + '/pengaturan',
                'environment': _BASE + '/workspace/' + projectId + '/environment',
                'keamanan': _BASE + '/workspace/' + projectId + '/keamanan',
            };
        }

        document.querySelectorAll('.sidebar-nav-link[data-page]').forEach(link => {
            const page = link.getAttribute('data-page');
            if (page === 'app') {
                link.setAttribute('href', _BASE + '/');
                return;
            }
            if (linkMap[page]) {
                link.setAttribute('href', linkMap[page]);
            }
        });
    },

    /**
     * Highlight the active sidebar link based on current URL
     */
    highlightActiveLink() {
        const section = this.getSection();
        const segments = this.getSegments();

        document.querySelectorAll('.sidebar-nav-link').forEach(link => {
            link.classList.remove('bg-gray-50', 'text-gray-800');
            link.classList.add('text-gray-700');

            const page = link.getAttribute('data-page');
            const currentPath = window.location.pathname;

            const href = link.getAttribute('href');
            if (href && href !== '#' && href !== _BASE + '/') {
                const normalizedHref = href.replace(/\/$/, '').replace(/\.html.*$/, '');
                const normalizedPath = currentPath.replace(/\/$/, '').replace(/\.html$/, '');
                if (normalizedHref === normalizedPath) {
                    link.classList.add('bg-gray-50', 'text-gray-800');
                    link.classList.remove('text-gray-700');
                }
            }

            if (page) {
                if ((page === 'workspace' && segments[2] === undefined && segments[0] === 'workspace') ||
                    (page === 'chat' && section === 'chat') ||
                    (page === 'pengaturan' && section === 'pengaturan') ||
                    (page === 'environment' && section === 'environment') ||
                    (page === 'keamanan' && section === 'keamanan')) {
                    link.classList.add('bg-gray-50', 'text-gray-800');
                    link.classList.remove('text-gray-700');
                }
            }
        });
    },

    init() {
        this.persistProjectId();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                this.patchSidebarLinks();
                this.highlightActiveLink();
            });
        } else {
            this.patchSidebarLinks();
            this.highlightActiveLink();
        }
        return {
            projectId: this.getProjectIdWithFallback(),
            section: this.getSection(),
            submenu: this.getSubmenu(),
            profileSection: this.getProfileSection(),
            segments: this.getSegments()
        };
    }
};

window._pathInfo = PathRouter.init();
