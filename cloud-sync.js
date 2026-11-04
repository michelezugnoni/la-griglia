/* ============================================================
   La Griglia — Sincronizzazione cloud con PocketBase
   Modulo standalone: non modifica l'architettura di app.js.
   Si collega a PocketBase Cloud.
   ============================================================ */

(function () {
    'use strict';

    // ---------- Configurazione ----------
    const PB_URL = 'https://ske2d9jdern256g.pwz5.pocketbasecloud.com';
    const COLLECTION_CONFIG = 'config';
    const COLLECTION_USERS = 'users';
    const USER_EMAIL = 'michelezugnoni1989@gmail.com';
    const USER_PASSWORD = 'Roccolilorla89!';
    const PULL_INTERVAL = 10000; // 10 secondi

    // ---------- Stato modulo ----------
    let authToken = null;
    let syncReady = false;
    let lastPushData = null;   // firma JSON dell'ultimo push (anti loop eco)
    let pullTimer = null;

    // ---------- Log helper ----------
    function log(msg) {
        console.log('[cloud-sync] ' + msg);
    }

    // ---------- Helper fetch su PocketBase ----------
    async function pbRequest(path, options) {
        const url = PB_URL + path;
        const headers = Object.assign({
            'Content-Type': 'application/json'
        }, authToken ? { 'Authorization': 'Bearer ' + authToken } : {});

        log('HTTP ' + (options && options.method ? options.method : 'GET') + ' ' + path);

        const response = await fetch(url, Object.assign({}, options, { headers: headers }));
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error('HTTP ' + response.status + (text ? ': ' + text.slice(0, 300) : ''));
        }
        return await response.json();
    }

    // ---------- Login utente (collezione "users") ----------
    async function pbLogin() {
        try {
            log('Tentativo login utente: ' + USER_EMAIL);
            const data = await pbRequest('/api/collections/' + COLLECTION_USERS + '/auth-with-password', {
                method: 'POST',
                body: JSON.stringify({
                    identity: USER_EMAIL,
                    password: USER_PASSWORD
                })
            });
            authToken = data.token;
            syncReady = true;
            log('Login OK, token ricevuto');
            return true;
        } catch (err) {
            console.error('❌ PocketBase login fallito:', err);
            syncReady = false;
            return false;
        }
    }

    // ---------- Trova l'ultimo record di configurazione ----------
    async function findConfigRecordId() {
        try {
            const data = await pbRequest('/api/collections/' + COLLECTION_CONFIG + '/records?perPage=1&sort=-updated');
            if (data.items && data.items.length > 0) {
                return data.items[0].id;
            }
            log('Nessun record trovato in config');
            return null;
        } catch (err) {
            console.error('❌ Errore ricerca record config:', err);
            return null;
        }
    }

    // ---------- Push: invia stato completo a cloud ----------
    async function pushState(stateData) {
        if (!syncReady) {
            log('Push saltato: non pronto');
            return { ok: false, reason: 'not-ready' };
        }

        const signature = JSON.stringify(stateData);
        if (lastPushData === signature) {
            log('Push saltato: identico all\'ultimo (anti echo)');
            return { ok: true, reason: 'echo-skip' };
        }

        try {
            const payload = {
                rooms: stateData.rooms,
                tables: stateData.tables,
                groups: stateData.groups,
                reservations: stateData.reservations,
                nextTableId: stateData.nextTableId,
                nextGroupId: stateData.nextGroupId,
                nextReservationId: stateData.nextReservationId,
                updatedAt: new Date().toISOString()
            };

            log('Invio payload al cloud, prenotazioni: ' + (stateData.reservations ? stateData.reservations.length : 0));

            const recordId = await findConfigRecordId();

            if (recordId) {
                log('Aggiornamento record esistente: ' + recordId);
                await pbRequest('/api/collections/' + COLLECTION_CONFIG + '/records/' + recordId, {
                    method: 'PATCH',
                    body: JSON.stringify({ payload: JSON.stringify(payload) })
                });
            } else {
                log('Creazione nuovo record in config');
                await pbRequest('/api/collections/' + COLLECTION_CONFIG + '/records', {
                    method: 'POST',
                    body: JSON.stringify({ payload: JSON.stringify(payload) })
                });
            }

            lastPushData = signature;
            log('Push completato con successo');
            return { ok: true };
        } catch (err) {
            console.error('❌ PocketBase push fallito:', err);
            syncReady = false;
            return { ok: false, reason: err.message };
        }
    }

    // ---------- Pull: recupera ultimo stato da cloud ----------
    async function pullState() {
        if (!syncReady) return null;

        try {
            const data = await pbRequest('/api/collections/' + COLLECTION_CONFIG + '/records?perPage=1&sort=-updated');
            if (!data.items || data.items.length === 0) {
                log('Pull: nessun record presente ancora');
                return null;
            }

            const record = data.items[0];
            let payload = null;
            if (record.payload) {
                payload = typeof record.payload === 'string' ? JSON.parse(record.payload) : record.payload;
                log('Pull: dati ricevuti dal cloud');
            }
            return payload;
        } catch (err) {
            console.error('❌ PocketBase pull fallito:', err);
            return null;
        }
    }

    // ---------- Applica stato ricevuto dal cloud ----------
    function applyCloudState(payload) {
        if (!payload) return false;

        if (typeof window.applyStateFromCloud === 'function') {
            window.applyStateFromCloud(payload);
            log('Stato applicato all\'app locale');
        }

        lastPushData = JSON.stringify(payload);
        return true;
    }

    // ---------- Badge di stato nella topbar ----------
    function setStatusBadge(kind) {
        let badge = document.getElementById('cloud-sync-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.id = 'cloud-sync-badge';
            badge.className = 'cloud-badge';
            const actions = document.querySelector('.topbar-actions');
            if (actions) actions.appendChild(badge);
        }

        const styles = {
            online:   { bg: '#fff7ef',  border: '#b8451f', color: '#963617', text: '☁️ Cloud online' },
            synced:   { bg: '#f0fdfa',  border: '#0f766e', color: '#0f766e', text: '☁️ Cloud sincronizzato' },
            offline:  { bg: '#f2f2f2',  border: '#9ca3af', color: '#7d746a', text: '☁️ Cloud offline' },
            error:    { bg: '#fde8e6',  border: '#a72b24', color: '#a72b24', text: '☁️ Errore cloud' }
        };

        const s = styles[kind] || styles.offline;
        badge.style.backgroundColor = s.bg;
        badge.style.borderColor = s.border;
        badge.style.color = s.color;
        badge.textContent = s.text;
    }

    // ---------- Timer pull periodico ----------
    function startPullTimer() {
        stopPullTimer();
        pullTimer = setInterval(async function () {
            const payload = await pullState();
            if (payload) {
                const sig = JSON.stringify(payload);
                if (sig !== lastPushData) {
                    applyCloudState(payload);
                    setStatusBadge('synced');
                    if (typeof window.__lg !== 'undefined' && typeof window.__lg.toast === 'function') {
                        window.__lg.toast('Dati aggiornati dal cloud.', 'info');
                    }
                }
            }
        }, PULL_INTERVAL);
        log('Timer pull avviato (ogni ' + (PULL_INTERVAL / 1000) + ' secondi)');
    }

    function stopPullTimer() {
        if (pullTimer) {
            clearInterval(pullTimer);
            pullTimer = null;
        }
    }

    // ---------- API pubblica ----------
    window.cloudSync = {
        ready: function () {
            // Riferimenti DOM non strettamente necessari per questo modulo
        },
        init: async function () {
            const ok = await pbLogin();
            if (ok) {
                setStatusBadge('online');
                const payload = await pullState();
                if (payload) {
                    applyCloudState(payload);
                    setStatusBadge('synced');
                    log('Sincronizzazione iniziale completata');
                } else {
                    log('Nessun dato cloud ancora: spingo stato attuale per creare il primo record');
                    // Spinge lo stato attuale per creare il primo record su cloud
                    if (typeof window.__lg !== 'undefined' && typeof window.__lg.state !== 'undefined') {
                        await pushState(window.__lg.state);
                        setStatusBadge('online');
                    }
                }
                startPullTimer();
            } else {
                setStatusBadge('offline');
            }
            return ok;
        },
        push: function (stateData) {
            return pushState(stateData);
        },
        isReady: function () {
            return syncReady;
        },
        // Forza una sincronizzazione manuale (utile per test)
        forceSync: async function () {
            const payload = await pullState();
            if (payload) {
                applyCloudState(payload);
                setStatusBadge('synced');
                return true;
            }
            return false;
        }
    };

    // ---------- Online/Offline ----------
    window.addEventListener('online', function () {
        if (!syncReady) {
            pbLogin().then(function (ok) {
                setStatusBadge(ok ? 'online' : 'offline');
            });
        }
    });
    window.addEventListener('offline', function () {
        setStatusBadge('offline');
        stopPullTimer();
    });

})();