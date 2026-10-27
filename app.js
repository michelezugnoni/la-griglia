/* ============================================================
   La Griglia — gestione prenotazioni
   Due sale con schema dedicato, tavoli con capienza variabile,
   gruppi come entità uniche, spostamento libero e feedback
   non invasivo.
   ============================================================ */

(function () {
    'use strict';

    const MAX_GROUP = 6;
    const MAX_SEATS = 12;
    const STORAGE_KEY = 'la-griglia-sala-v7';
    const CONFIG_KEY = 'la-griglia-config-v1';

    const state = {
        rooms: [],
        tables: [],
        groups: [],
        reservations: [],
        nextTableId: 1,
        nextGroupId: 1,
        nextReservationId: 1
    };

    let selection = [];
    let moveMode = false;
    let movePicked = null;
    let assigningReservationId = null;
    let editReservationId = null;
    let editRoomsMode = false;
    let resetTimer = null;
    let deleteTableTimer = null;
    let renumberTimer = null;
    let installPrompt = null;
    let activeTab = 'sala';
    let touchStart = null;
    let lastFocusBeforePrint = null;

    const TAB_IDS = ['nuova', 'sala', 'prenotazioni'];
    const MOBILE_QUERY = window.matchMedia('(max-width: 900px)');

    const els = {};

    document.addEventListener('DOMContentLoaded', init);

    /* ---------- Installazione (PWA / Android) ---------- */

    window.addEventListener('beforeinstallprompt', function (event) {
        event.preventDefault();
        installPrompt = event;
        if (els.installBtn) syncInstallButton();
    });

    window.addEventListener('appinstalled', function () {
        installPrompt = null;
        syncInstallButton();
        if (els.toastStack) {
            toast('App installata: puoi aprirla dalla schermata Home.', 'success');
        }
    });

    function isStandalone() {
        return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
            window.navigator.standalone === true;
    }

    function syncInstallButton() {
        if (!els.installBtn) return;
        els.installBtn.hidden = !installPrompt || isStandalone();
    }

    function onInstallClick() {
        if (!installPrompt) return;
        const prompt = installPrompt;
        installPrompt = null;
        prompt.prompt();
        const choice = prompt.userChoice;
        if (choice && typeof choice.then === 'function') {
            choice.then(function () {
                syncInstallButton();
            }).catch(function () {
                syncInstallButton();
            });
        } else {
            syncInstallButton();
        }
    }

    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return;

        window.addEventListener('load', function () {
            navigator.serviceWorker.register('./sw.js').catch(function () {
                /* Offline non disponibile: l'app continua a funzionare online. */
            });
        });
    }

    /* ---------- Navigazione a tab (mobile) ---------- */

    function isMobileLayout() {
        return MOBILE_QUERY.matches;
    }

    function setTab(tab, options) {
        if (TAB_IDS.indexOf(tab) === -1) return;
        activeTab = tab;

        TAB_IDS.forEach(function (id) {
            const button = els.tabs[id];
            const panel = els.panels[id];
            const active = id === tab;

            if (button) {
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-selected', active ? 'true' : 'false');
                button.tabIndex = active ? 0 : -1;
            }

            if (panel) {
                panel.classList.toggle('is-active', active);
            }
        });

        if (isMobileLayout() && (!options || options.scroll !== false)) {
            window.scrollTo({ top: 0, behavior: 'auto' });
        }
    }

    function bindTabs() {
        if (!els.tabBar) return;

        els.tabBar.addEventListener('click', function (event) {
            const button = event.target.closest('[data-tab]');
            if (!button) return;
            setTab(button.dataset.tab);
        });

        els.tabBar.addEventListener('keydown', function (event) {
            const index = TAB_IDS.indexOf(activeTab);
            let next = null;

            if (event.key === 'ArrowRight') next = (index + 1) % TAB_IDS.length;
            else if (event.key === 'ArrowLeft') next = (index - 1 + TAB_IDS.length) % TAB_IDS.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = TAB_IDS.length - 1;

            if (next === null) return;

            event.preventDefault();
            setTab(TAB_IDS[next]);
            if (els.tabs[TAB_IDS[next]]) els.tabs[TAB_IDS[next]].focus();
        });

        if (!els.workspace) return;

        els.workspace.addEventListener('touchstart', function (event) {
            if (!isMobileLayout() || event.touches.length !== 1) {
                touchStart = null;
                return;
            }
            touchStart = {
                x: event.touches[0].clientX,
                y: event.touches[0].clientY
            };
        }, { passive: true });

        els.workspace.addEventListener('touchend', function (event) {
            if (!touchStart || !isMobileLayout()) {
                touchStart = null;
                return;
            }

            const touch = event.changedTouches[0];
            const dx = touch.clientX - touchStart.x;
            const dy = touch.clientY - touchStart.y;
            touchStart = null;

            if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.6) return;

            const index = TAB_IDS.indexOf(activeTab);
            const next = dx < 0 ? index + 1 : index - 1;
            if (next >= 0 && next < TAB_IDS.length) setTab(TAB_IDS[next]);
        }, { passive: true });
    }

    /* ---------- Stampa ---------- */

    const PRINT_LABELS = {
        plan: 'Pianta della sala',
        reservations: 'Solo prenotazioni'
    };

    function currentSlotLabel() {
        const dateIso = els.date.value || todayIso();
        const time = els.time.value || '20:00';
        return formatDate(dateIso) + ' · ' + time;
    }

    function openPrintDialog() {
        if (!els.printDialog) return;

        lastFocusBeforePrint = document.activeElement;
        document.body.classList.remove('print-plan', 'print-reservations');

        if (els.printSlotLabel) {
            els.printSlotLabel.textContent = currentSlotLabel();
        }

        els.printDialog.hidden = false;
        document.body.classList.add('print-dialog-open');

        const first = els.printDialog.querySelector('[data-print-mode]');
        if (first) first.focus();
    }

    function closePrintDialog() {
        if (!els.printDialog || els.printDialog.hidden) return;

        els.printDialog.hidden = true;
        document.body.classList.remove('print-dialog-open');

        if (lastFocusBeforePrint && document.contains(lastFocusBeforePrint)) {
            lastFocusBeforePrint.focus();
        }
        lastFocusBeforePrint = null;
    }

    function updatePrintHeader(mode) {
        if (!els.printHeader) return;

        if (els.printDocTitle) {
            els.printDocTitle.textContent = PRINT_LABELS[mode] || 'Stampa';
        }
        if (els.printSlotLine) {
            els.printSlotLine.textContent = 'Slot: ' + currentSlotLabel();
        }
        if (els.printStatsLine) {
            const parts = [
                els.totalSeats.textContent + ' posti totali',
                els.bookedSeats.textContent + ' prenotati',
                els.freeSeats.textContent + ' liberi'
            ];
            if (els.reservationCount) {
                const count = Number(els.reservationCount.textContent) || 0;
                parts.push(count + (count === 1 ? ' prenotazione' : ' prenotazioni'));
            }
            els.printStatsLine.textContent = parts.join(' · ');
        }
    }

    function runPrint(mode) {
        if (!PRINT_LABELS[mode]) return;

        closePrintDialog();
        updatePrintHeader(mode);

        document.body.classList.remove('print-plan', 'print-reservations');
        document.body.classList.add(mode === 'plan' ? 'print-plan' : 'print-reservations');

        window.print();
    }

    function bindPrint() {
        if (els.printBtn) {
            els.printBtn.addEventListener('click', openPrintDialog);
        }

        if (!els.printDialog) return;

        els.printDialog.addEventListener('click', function (event) {
            if (event.target.closest('[data-print-close]')) {
                event.preventDefault();
                closePrintDialog();
                return;
            }

            const option = event.target.closest('[data-print-mode]');
            if (option) {
                runPrint(option.dataset.printMode);
            }
        });

        els.printDialog.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                event.preventDefault();
                closePrintDialog();
                return;
            }

            if (event.key !== 'Tab') return;

            const focusables = Array.prototype.filter.call(
                els.printDialog.querySelectorAll('[data-print-mode], [data-print-close]'),
                function (node) { return node.offsetParent !== null; }
            );
            if (focusables.length === 0) return;

            const first = focusables[0];
            const last = focusables[focusables.length - 1];

            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        });

        window.addEventListener('afterprint', function () {
            document.body.classList.remove('print-plan', 'print-reservations');
        });

        window.addEventListener('beforeprint', function () {
            if (document.body.classList.contains('print-plan') ||
                document.body.classList.contains('print-reservations')) {
                return;
            }

            const mode = activeTab === 'prenotazioni' ? 'reservations' : 'plan';
            updatePrintHeader(mode);
            document.body.classList.add(mode === 'plan' ? 'print-plan' : 'print-reservations');
        });
    }

    /* ---------- Init ---------- */

    function init() {
        cacheElements();
        buildTimeOptions(els.time);
        buildTimeOptions(els.formTime);
        if (!loadState()) {
            buildFreshState();
        }
        setDefaultSlot();
        bindEvents();
        bindTabs();
        bindPrint();
        syncSlotFields();
        renderAll();
        setTab(activeTab, { scroll: false });
        syncInstallButton();
        registerServiceWorker();
    }

    function cacheElements() {
        els.rooms = document.getElementById('roomsContainer');
        els.date = document.getElementById('dateInput');
        els.time = document.getElementById('timeInput');
        els.totalSeats = document.getElementById('totalSeats');
        els.bookedSeats = document.getElementById('bookedSeats');
        els.freeSeats = document.getElementById('freeSeats');
        els.totalFoot = document.getElementById('totalFoot');
        els.bookedFoot = document.getElementById('bookedFoot');
        els.freeFoot = document.getElementById('freeFoot');
        els.moveBtn = document.getElementById('moveBtn');
        els.combineBtn = document.getElementById('combineBtn');
        els.separateBtn = document.getElementById('separateBtn');
        els.editRoomsBtn = document.getElementById('editRoomsBtn');
        els.renumberBtn = document.getElementById('renumberBtn');
        els.resetBtn = document.getElementById('resetBtn');
        els.installBtn = document.getElementById('installBtn');
        els.workspace = document.getElementById('workspace');
        els.tabBar = document.getElementById('tabBar');
        els.tabs = {
            sala: document.getElementById('tabSala'),
            nuova: document.getElementById('tabNuova'),
            prenotazioni: document.getElementById('tabPrenotazioni')
        };
        els.panels = {
            sala: document.getElementById('panelSala'),
            nuova: document.getElementById('panelNuova'),
            prenotazioni: document.getElementById('panelPrenotazioni')
        };
        els.tabReservationCount = document.getElementById('tabReservationCount');
        els.tabSelectionDot = document.getElementById('tabSelectionDot');
        els.printBtn = document.getElementById('printBtn');
        els.printDialog = document.getElementById('printDialog');
        els.printSlotLabel = document.getElementById('printSlotLabel');
        els.printHeader = document.getElementById('printHeader');
        els.printDocTitle = document.getElementById('printDocTitle');
        els.printSlotLine = document.getElementById('printSlotLine');
        els.printStatsLine = document.getElementById('printStatsLine');
        els.statusLine = document.getElementById('statusLine');
        els.slotLabel = document.getElementById('slotLabel');
        els.targetInfo = document.getElementById('targetInfo');
        els.form = document.getElementById('reservationForm');
        els.formTitle = document.getElementById('formTitle');
        els.formDate = document.getElementById('formDate');
        els.formTime = document.getElementById('formTime');
        els.guestName = document.getElementById('guestName');
        els.guestPhone = document.getElementById('guestPhone');
        els.guestCount = document.getElementById('guestCount');
        els.guestNote = document.getElementById('guestNote');
        els.createBtn = document.getElementById('createBtn');
        els.cancelEditBtn = document.getElementById('cancelEditBtn');
        els.reservationCount = document.getElementById('reservationCount');
        els.reservationList = document.getElementById('reservationList');
        els.toastStack = document.getElementById('toastStack');
    }

    function setDefaultSlot() {
        if (!els.date.value) els.date.value = todayIso();
        if (!els.time.value) els.time.value = '20:00';
    }

    function defaultSetup() {
        function tableItem(id, col, row, colSpan, rowSpan) {
            return {
                kind: 'table',
                id: id,
                col: col,
                row: row,
                colSpan: colSpan || 1,
                rowSpan: rowSpan || 1
            };
        }

        // Le due sale sono in formato verticale 5 × 9 e affiancate.
        // I tavoli da 6 e 7 posti sono sempre orizzontali (2 × 1 celle),
        // così restano larghi il doppio di un tavolo da 3 posti.

        // Sala 1 — 11 tavoli da 3 posti.
        // In alto la fila di 4 tavoli, al centro la colonna di 3 tavoli con
        // la coppia laterale, in basso la coppia.
        const sala1Layout = [
            tableItem(8, 2, 1),
            tableItem(9, 3, 1),
            tableItem(10, 4, 1),
            tableItem(11, 5, 1),
            tableItem(5, 2, 4),
            tableItem(4, 2, 5),
            tableItem(6, 3, 5),
            tableItem(7, 4, 5),
            tableItem(3, 2, 6),
            tableItem(1, 2, 9),
            tableItem(2, 3, 9)
        ];

        // Sala 2 — 7 tavoli: due da 7 in basso, il tavolo da 7 in alto,
        // la coppia 7 + 6 al centro e il tavolo da 3 affiancato al 7.
        // Tutti i tavoli lunghi sono in orizzontale.
        const sala2Layout = [
            tableItem(18, 2, 1, 2, 1),
            tableItem(14, 1, 4, 2, 1),
            tableItem(15, 3, 4, 2, 1),
            tableItem(17, 2, 6, 2, 1),
            tableItem(16, 4, 6),
            tableItem(12, 1, 8, 2, 1),
            tableItem(13, 3, 8, 2, 1)
        ];

        const seats = {
            1: 3, 2: 3, 3: 3, 4: 3, 5: 3, 6: 3, 7: 3, 8: 3, 9: 3, 10: 3, 11: 3,
            12: 7, 13: 7, 14: 7, 15: 6, 16: 3, 17: 7, 18: 7
        };

        const tables = [];
        for (let id = 1; id <= 18; id++) {
            tables.push({
                id: id,
                seats: seats[id],
                roomId: id <= 11 ? 'sala1' : 'sala2'
            });
        }

        return {
            rooms: [
                {
                    id: 'sala1',
                    name: 'Sala 1',
                    cols: 5,
                    rows: 9,
                    layout: sala1Layout
                },
                {
                    id: 'sala2',
                    name: 'Sala 2',
                    cols: 5,
                    rows: 9,
                    layout: sala2Layout
                }
            ],
            tables: tables
        };
    }

    function applySetup(setup) {
        state.rooms = setup.rooms.map(function (room) {
            return {
                id: room.id,
                name: room.name,
                cols: room.cols,
                rows: room.rows,
                layout: room.layout.map(function (item) {
                    return {
                        kind: 'table',
                        id: item.id,
                        col: item.col,
                        row: item.row,
                        colSpan: item.colSpan,
                        rowSpan: item.rowSpan
                    };
                })
            };
        });

        state.tables = setup.tables.map(function (table) {
            return {
                id: table.id,
                seats: table.seats,
                groupId: null,
                roomId: table.roomId
            };
        });

        state.groups = [];
        state.reservations = [];
        state.nextGroupId = 1;
        state.nextReservationId = 1;
        state.nextTableId = state.tables.reduce(function (max, table) {
            return Math.max(max, table.id);
        }, 0) + 1;
    }

    function buildFreshState() {
        applySetup(loadConfig() || defaultSetup());
    }

    /* ---------- Model helpers ---------- */

    function getTable(id) {
        return state.tables.find(function (t) { return t.id === id; }) || null;
    }

    function getGroup(id) {
        return state.groups.find(function (g) { return g.id === id; }) || null;
    }

    function getReservation(id) {
        return state.reservations.find(function (r) { return r.id === id; }) || null;
    }

    function totalCapacity() {
        return state.tables.reduce(function (total, table) {
            return total + table.seats;
        }, 0);
    }

    function getRoom(id) {
        return state.rooms.find(function (r) { return r.id === id; }) || null;
    }

    function roomName(id) {
        const room = getRoom(id);
        return room ? room.name : '';
    }

    function entityRoomId(kind, id) {
        if (kind === 'table') {
            const table = getTable(id);
            return table ? table.roomId : null;
        }
        const group = getGroup(id);
        return group ? group.roomId : null;
    }

    function entityRoomName(kind, id) {
        return roomName(entityRoomId(kind, id));
    }

    function itemKey(kind, id) {
        return kind + ':' + id;
    }

    function cellKey(col, row) {
        return col + ':' + row;
    }

    function entityLocation(kind, id) {
        for (let r = 0; r < state.rooms.length; r++) {
            const room = state.rooms[r];
            const item = room.layout.find(function (entry) {
                return entry.kind === kind && entry.id === id;
            });
            if (item) {
                return { room: room, item: item };
            }
        }
        return null;
    }

    function setEntityRoom(kind, id, roomId) {
        if (kind === 'table') {
            const table = getTable(id);
            if (table) table.roomId = roomId;
            return;
        }
        const group = getGroup(id);
        if (!group) return;
        group.roomId = roomId;
        group.memberIds.forEach(function (tableId) {
            const table = getTable(tableId);
            if (table) table.roomId = roomId;
        });
    }

    function rectKeys(col, row, colSpan, rowSpan) {
        const keys = [];
        for (let r = 0; r < rowSpan; r++) {
            for (let c = 0; c < colSpan; c++) {
                keys.push(cellKey(col + c, row + r));
            }
        }
        return keys;
    }

    function rectsOverlap(a, b) {
        return a.col < b.col + b.colSpan &&
            a.col + a.colSpan > b.col &&
            a.row < b.row + b.rowSpan &&
            a.row + a.rowSpan > b.row;
    }

    function rectFits(room, col, row, colSpan, rowSpan, excludeKeys) {
        if (col < 1 || row < 1) return false;
        if (col + colSpan - 1 > room.cols) return false;
        if (row + rowSpan - 1 > room.rows) return false;

        const blocked = new Set();
        room.layout.forEach(function (item) {
            const key = itemKey(item.kind, item.id);
            if (excludeKeys && excludeKeys.has(key)) return;
            rectKeys(item.col, item.row, item.colSpan, item.rowSpan).forEach(function (cell) {
                blocked.add(cell);
            });
        });

        return rectKeys(col, row, colSpan, rowSpan).every(function (cell) {
            return !blocked.has(cell);
        });
    }

    function findFreeOrigin(room, clickCol, clickRow, colSpan, rowSpan, excludeKeys) {
        let best = null;

        for (let shiftCol = 0; shiftCol < colSpan; shiftCol++) {
            for (let shiftRow = 0; shiftRow < rowSpan; shiftRow++) {
                const col = clickCol - shiftCol;
                const row = clickRow - shiftRow;
                if (!rectFits(room, col, row, colSpan, rowSpan, excludeKeys)) continue;
                const distance = shiftCol + shiftRow;
                if (!best || distance < best.distance) {
                    best = { col: col, row: row, distance: distance };
                }
            }
        }

        return best;
    }

    function findNearestFreeOrigin(room, targetCol, targetRow, colSpan, rowSpan, excludeKeys) {
        let best = null;

        for (let row = 1; row + rowSpan - 1 <= room.rows; row++) {
            for (let col = 1; col + colSpan - 1 <= room.cols; col++) {
                if (!rectFits(room, col, row, colSpan, rowSpan, excludeKeys)) continue;
                const distance = Math.abs(col - targetCol) + Math.abs(row - targetRow);
                if (!best || distance < best.distance) {
                    best = { col: col, row: row, distance: distance };
                }
            }
        }

        return best;
    }

    function cellsConnected(cells) {
        if (cells.size === 0) return false;

        const first = cells.values().next().value;
        const visited = new Set([first]);
        const queue = [first];

        while (queue.length) {
            const parts = queue.pop().split(':');
            const col = Number(parts[0]);
            const row = Number(parts[1]);

            [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (step) {
                const key = cellKey(col + step[0], row + step[1]);
                if (cells.has(key) && !visited.has(key)) {
                    visited.add(key);
                    queue.push(key);
                }
            });
        }

        return visited.size === cells.size;
    }

    // Prepara l'unione: i tavoli devono essere adiacenti, il blocco che li
    // contiene non deve ospitare altri tavoli e il gruppo occupa l'intera area.
    function buildGroupPlan() {
        if (selection.length < 2 || selection.length > MAX_GROUP) return null;
        if (selection.some(function (s) { return s.kind !== 'table'; })) return null;

        const tables = selection.map(function (s) { return getTable(s.id); }).filter(Boolean);
        const ids = tables.map(function (t) { return t.id; });
        if (ids.length !== selection.length) return null;

        const roomId = entityRoomId('table', ids[0]);
        if (!roomId) return null;
        if (ids.some(function (id) { return entityRoomId('table', id) !== roomId; })) return null;
        if (tables.some(function (t) { return t.groupId !== null; })) return null;
        if (tables.some(function (t) { return !!activeReservation('table', t.id); })) return null;

        const locations = ids.map(function (id) {
            return entityLocation('table', id);
        }).filter(Boolean);
        if (locations.length !== ids.length) return null;

        const room = locations[0].room;
        if (locations.some(function (loc) { return loc.room.id !== room.id; })) return null;

        const cells = new Set();
        let minCol = Infinity;
        let minRow = Infinity;
        let maxCol = -Infinity;
        let maxRow = -Infinity;

        locations.forEach(function (loc) {
            const item = loc.item;
            minCol = Math.min(minCol, item.col);
            minRow = Math.min(minRow, item.row);
            maxCol = Math.max(maxCol, item.col + item.colSpan - 1);
            maxRow = Math.max(maxRow, item.row + item.rowSpan - 1);
            rectKeys(item.col, item.row, item.colSpan, item.rowSpan).forEach(function (cell) {
                cells.add(cell);
            });
        });

        if (!cellsConnected(cells)) return null;

        const selectedKeys = new Set(ids.map(function (id) { return itemKey('table', id); }));
        const occupiedByOthers = new Set();
        room.layout.forEach(function (item) {
            if (selectedKeys.has(itemKey(item.kind, item.id))) return;
            rectKeys(item.col, item.row, item.colSpan, item.rowSpan).forEach(function (cell) {
                occupiedByOthers.add(cell);
            });
        });

        for (let row = minRow; row <= maxRow; row++) {
            for (let col = minCol; col <= maxCol; col++) {
                const key = cellKey(col, row);
                if (!cells.has(key) && occupiedByOthers.has(key)) return null;
            }
        }

        return {
            room: room,
            tables: tables,
            ids: ids,
            locations: locations,
            col: minCol,
            row: minRow,
            colSpan: maxCol - minCol + 1,
            rowSpan: maxRow - minRow + 1,
            totalSeats: tables.reduce(function (total, table) {
                return total + table.seats;
            }, 0)
        };
    }

    function currentSlot() {
        return { date: els.date.value, time: els.time.value };
    }

    function matchesSlot(reservation) {
        const slot = currentSlot();
        return reservation.date === slot.date && reservation.time === slot.time;
    }

    function activeReservation(kind, id) {
        return state.reservations.find(function (r) {
            return matchesSlot(r) && r.target &&
                r.target.kind === kind && r.target.id === id;
        }) || null;
    }

    function groupSeats(group) {
        if (!group) return 0;
        return group.memberIds.reduce(function (total, tableId) {
            const table = getTable(tableId);
            return total + (table ? table.seats : 0);
        }, 0);
    }

    function entitySeats(entity) {
        if (entity.kind === 'group') {
            return groupSeats(getGroup(entity.id));
        }
        const table = getTable(entity.id);
        return table ? table.seats : 0;
    }

    function seatsSpan(seats) {
        // Fino a 5 posti il tavolo resta quadrato (1 cella).
        // Da 6 posti in su è sempre orizzontale: 2 celle fino a 8 posti,
        // 3 celle da 9 a 12 posti.
        if (seats <= 5) {
            return { colSpan: 1, rowSpan: 1 };
        }
        return {
            colSpan: Math.min(3, Math.max(2, Math.ceil(seats / 4))),
            rowSpan: 1
        };
    }

    function spanMatchesSeats(item, seats) {
        const span = seatsSpan(seats);
        return item.colSpan === span.colSpan && item.rowSpan === span.rowSpan;
    }

    function maxReservedGuests(tableId) {
        return state.reservations.reduce(function (max, reservation) {
            if (!reservation.target || reservation.target.kind !== 'table' || reservation.target.id !== tableId) {
                return max;
            }
            return Math.max(max, reservation.guests);
        }, 0);
    }

    function maxGroupReservedGuests(groupId) {
        return state.reservations.reduce(function (max, reservation) {
            if (!reservation.target || reservation.target.kind !== 'group' || reservation.target.id !== groupId) {
                return max;
            }
            return Math.max(max, reservation.guests);
        }, 0);
    }

    function shortName(entity) {
        if (entity.kind === 'table') {
            return 'Tavolo ' + entity.id;
        }
        const group = getGroup(entity.id);
        if (!group) return 'Gruppo';
        return 'Gruppo T' + group.memberIds.join(' + T');
    }

    function fullName(entity) {
        const roomLabel = entityRoomName(entity.kind, entity.id);
        return shortName(entity) + (roomLabel ? ' · ' + roomLabel : '');
    }

    function isSelected(entity) {
        return selection.some(function (s) {
            return s.kind === entity.kind && s.id === entity.id;
        });
    }

    function isFreeTable(id) {
        const table = getTable(id);
        return !!table && table.groupId === null && !activeReservation('table', id);
    }

    function roomStats(room) {
        let count = 0;
        let seats = 0;
        state.groups.forEach(function (group) {
            if (group.roomId !== room.id) return;
            count++;
            seats += groupSeats(group);
        });
        state.tables.forEach(function (table) {
            if (table.groupId !== null || table.roomId !== room.id) return;
            count++;
            seats += table.seats;
        });
        return { count: count, seats: seats };
    }

    /* ---------- Rendering: rooms ---------- */

    function renderRooms() {
        const fragment = document.createDocumentFragment();
        state.rooms.forEach(function (room) {
            fragment.appendChild(renderRoom(room));
        });
        els.rooms.classList.toggle('is-moving', moveMode);
        els.rooms.classList.toggle('is-assigning', !!assigningReservationId);
        els.rooms.classList.toggle('is-editing-rooms', editRoomsMode);
        els.rooms.replaceChildren(fragment);
    }

    function renderRoom(room) {
        const section = document.createElement('section');
        section.className = 'room';
        section.dataset.roomId = room.id;

        const head = document.createElement('div');
        head.className = 'room-head';

        const heading = document.createElement('div');
        heading.className = 'room-heading';
        heading.appendChild(el('h3', 'room-name', room.name));

        const stats = roomStats(room);
        heading.appendChild(el(
            'span',
            'room-meta',
            stats.count + ' tavoli · ' + stats.seats + ' posti'
        ));
        head.appendChild(heading);

        if (editRoomsMode) {
            const tools = el('div', 'room-tools');
            tools.appendChild(el('span', 'room-hint', 'Modifica sale'));

            const add = el('button', 'btn btn-add-table', '+ Tavolo');
            add.type = 'button';
            add.dataset.addTable = room.id;
            add.setAttribute('aria-label', 'Aggiungi un tavolo in ' + room.name);
            add.title = 'Aggiungi un tavolo da 3 posti in ' + room.name;
            tools.appendChild(add);

            head.appendChild(tools);
        } else if (moveMode) {
            head.appendChild(el('span', 'room-hint', 'Celle libere attive'));
        } else if (assigningReservationId) {
            head.appendChild(el('span', 'room-hint', 'Scegli un tavolo'));
        }

        const grid = document.createElement('div');
        grid.className = 'room-grid';
        grid.dataset.roomId = room.id;
        grid.style.setProperty('--cols', String(room.cols));
        grid.style.setProperty('--rows', String(room.rows));
        grid.setAttribute('role', 'group');
        grid.setAttribute('aria-label', 'Pianta ' + room.name);

        const sorted = room.layout.slice().sort(function (a, b) {
            return a.row - b.row || a.col - b.col;
        });

        sorted.forEach(function (item) {
            if (item.kind === 'table') {
                const table = getTable(item.id);
                if (!table || table.groupId !== null) return;
                grid.appendChild(renderTableEntity(table, room, item));
                return;
            }

            if (item.kind === 'group') {
                const group = getGroup(item.id);
                if (!group) return;
                grid.appendChild(renderGroupEntity(group, room, item));
            }
        });

        if (moveMode) {
            const occupied = new Set();
            room.layout.forEach(function (item) {
                rectKeys(item.col, item.row, item.colSpan, item.rowSpan)
                    .forEach(function (cell) { occupied.add(cell); });
            });

            for (let row = 1; row <= room.rows; row++) {
                for (let col = 1; col <= room.cols; col++) {
                    if (occupied.has(cellKey(col, row))) continue;
                    grid.appendChild(renderGap(room, col, row));
                }
            }
        }

        section.appendChild(head);
        section.appendChild(grid);
        return section;
    }

    function renderGap(room, col, row) {
        const gap = document.createElement('div');
        gap.className = 'floor-gap is-target';
        gap.dataset.roomId = room.id;
        gap.dataset.col = String(col);
        gap.dataset.row = String(row);
        gap.style.gridColumn = col + ' / span 1';
        gap.style.gridRow = row + ' / span 1';
        gap.setAttribute('role', 'button');
        gap.tabIndex = 0;
        gap.setAttribute('aria-label', 'Cella libera in ' + room.name);
        gap.title = 'Posiziona qui il tavolo selezionato';
        return gap;
    }

    function placeItem(node, item) {
        node.style.gridColumn = item.col + ' / span ' + item.colSpan;
        node.style.gridRow = item.row + ' / span ' + item.rowSpan;
        node.dataset.col = String(item.col);
        node.dataset.row = String(item.row);
        node.dataset.colSpan = String(item.colSpan);
        node.dataset.rowSpan = String(item.rowSpan);
    }

    function createEntityCard(entity, item, reservation, extraClass, room) {
        const card = document.createElement('div');
        card.className = 'entity ' + extraClass;
        card.dataset.kind = entity.kind;
        card.dataset.id = String(entity.id);
        card.dataset.roomId = room.id;
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        card.setAttribute('aria-pressed', isSelected(entity) ? 'true' : 'false');
        card.classList.add(reservation ? 'is-booked' : 'is-free');

        if (isSelected(entity)) card.classList.add('is-selected');
        if (movePicked && movePicked.kind === entity.kind && movePicked.id === entity.id) {
            card.classList.add('is-picked');
        }
        if (assigningReservationId) {
            const pending = getReservation(assigningReservationId);
            const assignable = pending && !reservation && entitySeats(entity) >= pending.guests;
            card.classList.toggle('is-assignable', !!assignable);
        }

        placeItem(card, item);
        return card;
    }

    function renderTableEntity(table, room, item) {
        const entity = { kind: 'table', id: table.id };
        const reservation = activeReservation('table', table.id);
        const card = createEntityCard(entity, item, reservation, 'entity-table', room);
        card.dataset.seats = String(table.seats);

        card.setAttribute(
            'aria-label',
            room.name + ', TAVOLO T' + table.id + ', ' + table.seats + ' posti, ' +
            (reservation
                ? 'prenotato da ' + reservation.name + ' per ' + reservation.guests + ' ospiti'
                : 'Libero')
        );

        card.appendChild(el('span', 'entity-tag', 'Tavolo'));
        card.appendChild(el('span', 'entity-name', 'T' + table.id));
        card.appendChild(el(
            'span',
            'entity-seats',
            reservation
                ? reservation.guests + (reservation.guests === 1 ? ' ospite' : ' ospiti')
                : table.seats + ' posti'
        ));
        card.appendChild(el(
            'span',
            'entity-note',
            reservation ? reservation.name : 'Libero'
        ));

        return card;
    }

    function renderGroupEntity(group, room, item) {
        const entity = { kind: 'group', id: group.id };
        const reservation = activeReservation('group', group.id);
        const seats = groupSeats(group);
        const card = createEntityCard(entity, item, reservation, 'entity-table entity-group', room);

        card.setAttribute(
            'aria-label',
            room.name + ', GRUPPO · ' + group.memberIds.length + ' TAVOLI (' +
            group.memberIds.map(function (id) { return 'T' + id; }).join(' + ') + '), ' +
            seats + ' posti, ' +
            (reservation ? 'prenotato da ' + reservation.name : 'unito e libero')
        );

        card.appendChild(el(
            'span',
            'entity-tag',
            'Gruppo · ' + group.memberIds.length + ' tavoli'
        ));
        card.appendChild(el(
            'span',
            'entity-name',
            reservation
                ? reservation.guests + (reservation.guests === 1 ? ' ospite' : ' ospiti')
                : seats + ' posti'
        ));

        const members = el('span', 'entity-members');
        group.memberIds.slice(0, 4).forEach(function (id) {
            members.appendChild(el('span', 'chip', 'T' + id));
        });
        if (group.memberIds.length > 4) {
            members.appendChild(el('span', 'chip', '+' + (group.memberIds.length - 4)));
        }
        card.appendChild(members);

        card.appendChild(el(
            'span',
            'entity-note',
            reservation ? 'Prenotato · ' + reservation.name : 'Unito · seleziona per separare'
        ));

        return card;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    /* ---------- Rendering: selection, summary, list, form ---------- */

    function renderAll() {
        renderRooms();
        renderSelectionUI();
        syncForm();
        renderSummary();
        renderReservations();
        syncFormMode();

        const slot = currentSlot();
        els.slotLabel.textContent = 'Slot attivo: ' + formatDate(slot.date) + ' · ' + slot.time;
    }

    function selectionSeats() {
        return selection.reduce(function (total, entity) {
            return total + entitySeats(entity);
        }, 0);
    }

    function statusMessage() {
        if (assigningReservationId) {
            const pending = getReservation(assigningReservationId);
            if (pending) {
                return 'Assegna ' + pending.name + ' · ' + pending.guests +
                    ' ospiti: scegli un tavolo o un gruppo libero con capienza sufficiente.';
            }
        }

        if (moveMode) {
            if (!movePicked) {
                return 'Spostamento attivo: scegli un tavolo, poi una cella libera o un altro tavolo, anche in un\'altra sala.';
            }
            return shortName(movePicked) + ' pronto: scegli una cella libera o un altro tavolo come destinazione.';
        }

        if (editRoomsMode) {
            return 'Modifica sale: ' + state.tables.length + ' tavoli · ' + totalCapacity() +
                ' posti totali. Aggiungi o elimina tavoli, cambia i posti e usa “Sposta tavoli” per la disposizione. Le modifiche restano dopo “Ripristina sala”.';
        }

        if (selection.length === 0) {
            return 'Seleziona un tavolo o un gruppo; seleziona più tavoli della stessa sala per unirli.';
        }

        if (selection.length === 1) {
            const entity = selection[0];
            const reservation = activeReservation(entity.kind, entity.id);

            if (entity.kind === 'group') {
                if (reservation) {
                    return fullName(entity) + ' è prenotato da ' + reservation.name +
                        ': annulla la prenotazione per separarlo.';
                }
                return fullName(entity) + ' selezionato · ' + entitySeats(entity) +
                    ' posti. Premi Separa tavoli per tornare ai tavoli singoli.';
            }

            if (reservation) {
                return fullName(entity) + ' prenotato da ' + reservation.name +
                    ' (' + reservation.guests + ' ospiti).';
            }
            return fullName(entity) + ' selezionato · ' + entitySeats(entity) +
                ' posti. Aggiungi tavoli della stessa sala per unirli o compila il form.';
        }

        return selection.length + ' tavoli selezionati · ' +
            selectionSeats() + ' posti combinabili. Premi Unisci tavoli.';
    }

    function canCombine() {
        return !!buildGroupPlan();
    }

    function canSeparate() {
        return selection.length === 1 && selection[0].kind === 'group';
    }

    function renderSelectionUI() {
        els.statusLine.textContent = statusMessage();

        const combineDisabled = editRoomsMode || !canCombine();
        els.combineBtn.classList.toggle('is-inactive', combineDisabled);
        els.combineBtn.classList.toggle('is-active', !editRoomsMode && canCombine());
        els.combineBtn.setAttribute('aria-disabled', String(combineDisabled));

        const separateDisabled = editRoomsMode || !canSeparate();
        els.separateBtn.classList.toggle('is-inactive', separateDisabled);
        els.separateBtn.classList.toggle('is-active', !editRoomsMode && canSeparate());
        els.separateBtn.setAttribute('aria-disabled', String(separateDisabled));

        els.moveBtn.classList.toggle('is-active', moveMode);
        els.moveBtn.textContent = moveMode ? 'Termina spostamento' : 'Sposta tavoli';

        if (els.tabSelectionDot) {
            els.tabSelectionDot.hidden = selection.length === 0;
        }
    }

    function renderSummary() {
        let total = 0;
        let booked = 0;
        const entities = [];

        state.groups.forEach(function (group) {
            const seats = groupSeats(group);
            entities.push({ kind: 'group', id: group.id });
            total += seats;
        });

        state.tables.forEach(function (table) {
            if (table.groupId !== null) return;
            entities.push({ kind: 'table', id: table.id });
            total += table.seats;
        });

        let activeCount = 0;
        entities.forEach(function (entity) {
            const reservation = activeReservation(entity.kind, entity.id);
            if (reservation) {
                booked += reservation.guests;
                activeCount++;
            }
        });

        state.reservations.forEach(function (reservation) {
            if (!matchesSlot(reservation) || reservation.target) return;
            booked += reservation.guests;
            activeCount++;
        });

        const free = Math.max(0, total - booked);
        const percent = total > 0 ? Math.round((free / total) * 100) : 0;

        els.totalSeats.textContent = String(total);
        els.bookedSeats.textContent = String(booked);
        els.freeSeats.textContent = String(free);

        const groupLabel = state.groups.length === 1 ? '1 gruppo' : state.groups.length + ' gruppi';
        els.totalFoot.textContent = state.tables.length + ' tavoli · ' + groupLabel;
        els.bookedFoot.textContent = activeCount > 0
            ? activeCount + (activeCount === 1 ? ' prenotazione attiva' : ' prenotazioni attive')
            : 'Nessuna prenotazione in questo slot';
        els.freeFoot.textContent = total > 0 ? percent + '% della capienza libero' : 'Sala non disponibile';
    }

    function renderReservations() {
        const reserved = state.reservations
            .filter(matchesSlot)
            .sort(function (a, b) { return a.id - b.id; });

        els.reservationCount.textContent = String(reserved.length);
        els.reservationList.replaceChildren();

        if (els.tabReservationCount) {
            els.tabReservationCount.textContent = String(reserved.length);
            els.tabReservationCount.hidden = reserved.length === 0;
        }

        if (reserved.length === 0) {
            els.reservationList.appendChild(el(
                'p',
                'empty-state',
                'Nessuna prenotazione per questo slot.'
            ));
            return;
        }

        reserved.forEach(function (reservation) {
            els.reservationList.appendChild(renderReservationItem(reservation));
        });
    }

    function renderReservationItem(reservation) {
        const article = document.createElement('article');
        const assigned = !!reservation.target;
        article.className = 'reservation' + (assigned ? '' : ' is-unassigned');

        const body = document.createElement('div');
        body.className = 'reservation-body';
        body.appendChild(el('p', 'reservation-name', reservation.name));
        body.appendChild(el(
            'p',
            'reservation-meta',
            reservation.guests + ' ospiti · ' +
            (assigned ? fullName(reservation.target) : 'Senza tavolo') +
            (reservation.phone ? ' · ' + reservation.phone : '')
        ));
        if (reservation.note) {
            body.appendChild(el('p', 'reservation-note', reservation.note));
        }
        article.appendChild(body);

        const actions = el('div', 'reservation-actions');

        const edit = el('button', 'btn btn-edit', 'Modifica');
        edit.type = 'button';
        edit.setAttribute('aria-label', 'Modifica la prenotazione di ' + reservation.name);
        edit.addEventListener('click', function () {
            startEdit(reservation.id);
        });
        actions.appendChild(edit);

        if (!assigned) {
            const assign = el('button', 'btn btn-assign', 'Assegna');
            assign.type = 'button';
            assign.setAttribute(
                'aria-label',
                'Assegna un tavolo alla prenotazione di ' + reservation.name
            );
            assign.addEventListener('click', function () {
                startAssign(reservation.id);
            });
            actions.appendChild(assign);
        }

        const cancel = el('button', 'btn btn-cancel', 'Annulla');
        cancel.type = 'button';
        cancel.setAttribute('aria-label', 'Annulla la prenotazione di ' + reservation.name);
        cancel.dataset.reservationId = String(reservation.id);
        cancel.dataset.confirming = '0';
        cancel.addEventListener('click', function () {
            requestCancel(reservation.id, cancel);
        });

        actions.appendChild(cancel);
        article.appendChild(actions);
        return article;
    }

    function syncFormMode() {
        const editing = editReservationId !== null;
        els.formTitle.textContent = editing ? 'Modifica prenotazione' : 'Nuova prenotazione';
        els.createBtn.textContent = editing ? 'Salva modifiche' : 'Crea prenotazione';
        els.cancelEditBtn.hidden = !editing;

        els.editRoomsBtn.classList.toggle('is-active', editRoomsMode);
        els.editRoomsBtn.textContent = editRoomsMode ? 'Fine modifica sale' : 'Modifica sale';
        els.editRoomsBtn.setAttribute('aria-pressed', editRoomsMode ? 'true' : 'false');

        els.renumberBtn.hidden = !editRoomsMode;
        if (!editRoomsMode && els.renumberBtn.dataset.confirming === '1') {
            window.clearTimeout(renumberTimer);
            els.renumberBtn.dataset.confirming = '0';
            els.renumberBtn.classList.remove('is-danger');
            els.renumberBtn.textContent = 'Rinumera tavoli';
        } else if (els.renumberBtn.dataset.confirming !== '1') {
            els.renumberBtn.textContent = 'Rinumera tavoli';
            els.renumberBtn.classList.remove('is-danger');
        }
    }

    function syncForm() {
        const single = selection.length === 1 ? selection[0] : null;
        const editingReservation = editReservationId !== null ? getReservation(editReservationId) : null;

        els.targetInfo.className = 'target';
        els.targetInfo.replaceChildren();

        if (!single) {
            els.targetInfo.classList.add('is-empty');
            els.createBtn.setAttribute('aria-disabled', 'false');
            syncGuestLimit(totalCapacity(), false);

            if (editRoomsMode) {
                els.targetInfo.classList.add('is-setup');
                els.targetInfo.appendChild(el(
                    'p',
                    'target-empty',
                    'Modifica sale: seleziona un tavolo per cambiarne i posti, eliminalo o aggiungine uno con “+ Tavolo”. I numeri eliminati tornano disponibili; “Rinumera tavoli” ricompatta la numerazione. “Ripristina sala” manterrà questa configurazione.'
                ));

                const factory = el('button', 'btn btn-factory btn-block', 'Ripristina disposizione iniziale');
                factory.type = 'button';
                factory.dataset.confirming = '0';
                factory.addEventListener('click', function () {
                    requestFactorySetup(factory);
                });
                els.targetInfo.appendChild(factory);
                return;
            }

            els.targetInfo.appendChild(el(
                'p',
                'target-empty',
                editingReservation
                    ? 'Prenotazione senza tavolo: salva le modifiche oppure seleziona un tavolo per assegnarla.'
                    : selection.length > 1
                        ? 'Più tavoli selezionati: uniscili oppure selezionane uno. Per prenotare senza tavolo, deseleziona tutto.'
                        : 'Nessun tavolo selezionato: la prenotazione sarà salvata senza tavolo e potrai assegnarlo in un secondo momento.'
            ));
            return;
        }

        const seats = entitySeats(single);
        const reservation = activeReservation(single.kind, single.id);
        const roomLabel = entityRoomName(single.kind, single.id);
        syncGuestLimit(seats);

        const top = el('div', 'target-top');
        top.appendChild(el('span', 'target-name', shortName(single)));
        top.appendChild(el('span', 'target-seats', seats + ' posti'));
        els.targetInfo.appendChild(top);

        if (reservation) {
            const editingThis = editingReservation && editingReservation.id === reservation.id;

            if (editingThis) {
                els.targetInfo.classList.add('is-editing');
                els.targetInfo.appendChild(el(
                    'p',
                    'target-note',
                    roomLabel + ' · modifica della prenotazione di ' + reservation.name +
                    ' (' + reservation.guests + ' ospiti)'
                ));
                els.createBtn.setAttribute('aria-disabled', 'false');
            } else {
                els.targetInfo.classList.add('is-busy');
                els.targetInfo.appendChild(el(
                    'p',
                    'target-note',
                    roomLabel + ' · prenotato da ' + reservation.name +
                    ' (' + reservation.guests + ' ospiti)'
                ));
                els.createBtn.setAttribute('aria-disabled', 'true');

                const edit = el('button', 'btn btn-edit', 'Modifica prenotazione');
                edit.type = 'button';
                edit.setAttribute('aria-label', 'Modifica la prenotazione di ' + reservation.name);
                edit.addEventListener('click', function () {
                    startEdit(reservation.id);
                });
                els.targetInfo.appendChild(edit);
            }
        } else {
            els.targetInfo.classList.add('is-free');
            els.targetInfo.appendChild(el(
                'p',
                'target-note',
                roomLabel + ' · ' + (single.kind === 'group'
                    ? 'tavolo unico con capienza già sommata.'
                    : 'disponibile per questo slot.')
            ));
            els.createBtn.setAttribute('aria-disabled', 'false');
        }

        if (single.kind === 'table') {
            els.targetInfo.appendChild(buildSeatEditor(single.id));
        } else {
            const group = getGroup(single.id);
            if (group) els.targetInfo.appendChild(buildGroupSeatEditor(group));
        }

        if (editRoomsMode && single.kind === 'table') {
            els.targetInfo.appendChild(buildDeleteTableControl(single.id));
        }
    }

    function buildDeleteTableControl(tableId) {
        const wrapper = el('div', 'setup-box');
        wrapper.appendChild(el(
            'p',
            'setup-hint',
            'Modifica permanente: posti e posizione restano anche dopo “Ripristina sala”.'
        ));

        const used = tableReservations(tableId).length;
        const button = el('button', 'btn btn-danger btn-block', 'Elimina tavolo');
        button.type = 'button';
        button.dataset.deleteTable = String(tableId);

        if (used > 0) {
            button.disabled = true;
            wrapper.appendChild(el(
                'p',
                'setup-hint',
                used === 1
                    ? 'Il tavolo ha 1 prenotazione: annullala per eliminarlo.'
                    : 'Il tavolo ha ' + used + ' prenotazioni: annullale per eliminarlo.'
            ));
        } else if (state.tables.length <= 1) {
            button.disabled = true;
            wrapper.appendChild(el('p', 'setup-hint', 'Deve restare almeno un tavolo.'));
        } else {
            button.addEventListener('click', function () {
                requestDeleteTable(tableId, button);
            });
        }

        wrapper.appendChild(button);
        return wrapper;
    }

    function capacityError(seats, single) {
        return (single ? 'Capienza massima: ' : 'Capienza totale: ') + seats + ' posti.';
    }

    function syncGuestLimit(seats, single) {
        els.guestCount.max = String(seats);
        const value = Number(els.guestCount.value);
        if (els.guestCount.value !== '' && Number.isFinite(value) && value > seats) {
            setFieldError(els.guestCount, capacityError(seats, single !== false));
        } else if (els.guestCount.classList.contains('invalid')) {
            clearFieldError(els.guestCount);
        }
    }

    function createSeatControls(table) {
        const controls = el('div', 'seat-controls');
        const minus = el('button', 'seat-step', '−');
        minus.type = 'button';
        minus.dataset.seatStep = '-1';
        minus.dataset.tableId = String(table.id);
        minus.setAttribute('aria-label', 'Riduci di un posto al tavolo ' + table.id);
        minus.toggleAttribute('disabled', table.seats <= 1);

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'seat-input';
        input.dataset.tableId = String(table.id);
        input.min = '1';
        input.max = String(MAX_SEATS);
        input.step = '1';
        input.inputMode = 'numeric';
        input.value = String(table.seats);
        input.setAttribute('aria-label', 'Numero di posti del tavolo ' + table.id);

        const plus = el('button', 'seat-step', '+');
        plus.type = 'button';
        plus.dataset.seatStep = '1';
        plus.dataset.tableId = String(table.id);
        plus.setAttribute('aria-label', 'Aggiungi un posto al tavolo ' + table.id);
        plus.toggleAttribute('disabled', table.seats >= MAX_SEATS);

        controls.appendChild(minus);
        controls.appendChild(input);
        controls.appendChild(plus);
        return controls;
    }

    function buildSeatEditor(tableId) {
        const table = getTable(tableId);
        const blocked = maxReservedGuests(tableId);
        const wrapper = el('div', 'seat-editor');
        wrapper.dataset.tableId = String(tableId);

        const head = el('div', 'seat-editor-head');
        head.appendChild(el('span', 'seat-editor-label', 'Posti del tavolo'));
        head.appendChild(el('span', 'seat-editor-count', table ? table.seats + ' posti' : '—'));
        wrapper.appendChild(head);

        if (!table) return wrapper;

        wrapper.appendChild(createSeatControls(table));

        const hint = el(
            'p',
            'seat-hint',
            'Da 1 a 5 posti: tavolo quadrato. Da 6 a 12 posti: tavolo lungo orizzontale.'
        );
        if (blocked > 0) {
            hint.textContent += ' Riduzione minima consentita: ' + blocked +
                (blocked === 1 ? ' posto (prenotazione attiva).' : ' posti (prenotazione attiva).');
        }
        wrapper.appendChild(hint);

        const error = el('p', 'seat-error');
        error.setAttribute('role', 'alert');
        wrapper.appendChild(error);

        return wrapper;
    }

    function buildGroupSeatEditor(group) {
        const blocked = maxGroupReservedGuests(group.id);
        const wrapper = el('div', 'seat-editor seat-editor-group');
        wrapper.dataset.groupId = String(group.id);

        const head = el('div', 'seat-editor-head');
        head.appendChild(el('span', 'seat-editor-label', 'Posti dei tavoli uniti'));
        head.appendChild(el('span', 'seat-editor-count', groupSeats(group) + ' posti'));
        wrapper.appendChild(head);

        const list = el('div', 'seat-members');
        group.memberIds.forEach(function (tableId) {
            const table = getTable(tableId);
            if (!table) return;

            const row = el('div', 'seat-member');
            row.dataset.tableId = String(tableId);
            row.appendChild(el('span', 'seat-member-label', 'T' + tableId));
            row.appendChild(createSeatControls(table));
            list.appendChild(row);
        });
        wrapper.appendChild(list);

        const hint = el(
            'p',
            'seat-hint',
            'La capienza totale si aggiorna subito. Se un tavolo si allarga, il gruppo si riposiziona quando serve.'
        );
        if (blocked > 0) {
            hint.textContent += ' Riduzione minima del gruppo: ' + blocked +
                (blocked === 1 ? ' posto (prenotazione attiva).' : ' posti (prenotazione attiva).');
        }
        wrapper.appendChild(hint);

        const error = el('p', 'seat-error');
        error.setAttribute('role', 'alert');
        wrapper.appendChild(error);

        return wrapper;
    }

    function showSeatError(message) {
        const error = document.querySelector('.seat-editor .seat-error');
        if (error) error.textContent = message || '';
        document.querySelectorAll('.seat-input').forEach(function (input) {
            input.classList.toggle('invalid', !!message);
        });
    }

    function applyTableSeats(tableId, requested) {
        const table = getTable(tableId);
        if (!table) {
            return { ok: false, error: 'Tavolo non trovato.' };
        }

        const seats = Number(requested);
        if (!Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS) {
            return { ok: false, error: 'Capienza consentita: da 1 a ' + MAX_SEATS + ' posti.' };
        }

        if (seats === table.seats) {
            return { ok: true, unchanged: true, table: table };
        }

        if (table.groupId !== null) {
            return applyGroupedTableSeats(table, seats);
        }

        const reserved = maxReservedGuests(tableId);
        if (seats < reserved) {
            return {
                ok: false,
                error: 'Riduzione non consentita: una prenotazione occupa ' +
                    reserved + (reserved === 1 ? ' posto.' : ' posti.')
            };
        }

        const location = entityLocation('table', tableId);
        if (!location) {
            return { ok: false, error: 'Tavolo non presente nella pianta.' };
        }

        const room = location.room;
        const item = location.item;
        const span = seatsSpan(seats);

        if (item.colSpan !== span.colSpan || item.rowSpan !== span.rowSpan) {
            const exclude = new Set([itemKey('table', tableId)]);
            let origin = null;

            if (rectFits(room, item.col, item.row, span.colSpan, span.rowSpan, exclude)) {
                origin = { col: item.col, row: item.row };
            } else {
                origin = findNearestFreeOrigin(
                    room,
                    item.col,
                    item.row,
                    span.colSpan,
                    span.rowSpan,
                    exclude
                );
            }

            if (!origin) {
                return {
                    ok: false,
                    error: 'Spazio insufficiente: libera una cella accanto al tavolo per allargarlo.'
                };
            }

            item.col = origin.col;
            item.row = origin.row;
            item.colSpan = span.colSpan;
            item.rowSpan = span.rowSpan;
        }

        table.seats = seats;
        saveState();
        if (editRoomsMode) saveConfig();
        renderRooms();
        renderSummary();
        renderSelectionUI();
        return { ok: true, table: table };
    }

    function applyGroupedTableSeats(table, seats) {
        const group = getGroup(table.groupId);
        if (!group) {
            return { ok: false, error: 'Gruppo non trovato.' };
        }

        const nextTotal = groupSeats(group) - table.seats + seats;
        const reserved = maxGroupReservedGuests(group.id);
        if (nextTotal < reserved) {
            return {
                ok: false,
                error: 'Riduzione non consentita: una prenotazione occupa ' +
                    reserved + (reserved === 1 ? ' posto.' : ' posti.')
            };
        }

        const location = entityLocation('group', group.id);
        if (!location) {
            return { ok: false, error: 'Gruppo non presente nella pianta.' };
        }

        const room = location.room;
        const groupItem = location.item;
        const span = seatsSpan(seats);

        const rects = group.offsets.map(function (offset) {
            const changed = offset.id === table.id;
            return {
                id: offset.id,
                dCol: offset.dCol,
                dRow: offset.dRow,
                colSpan: changed ? span.colSpan : offset.colSpan,
                rowSpan: changed ? span.rowSpan : offset.rowSpan
            };
        });

        for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
                if (rectsOverlap(
                    { col: rects[i].dCol, row: rects[i].dRow, colSpan: rects[i].colSpan, rowSpan: rects[i].rowSpan },
                    { col: rects[j].dCol, row: rects[j].dRow, colSpan: rects[j].colSpan, rowSpan: rects[j].rowSpan }
                )) {
                    return {
                        ok: false,
                        error: 'Spazio insufficiente all\'interno del gruppo: allarga il gruppo o riduci un altro tavolo.'
                    };
                }
            }
        }

        const cells = new Set();
        rects.forEach(function (rect) {
            rectKeys(rect.dCol, rect.dRow, rect.colSpan, rect.rowSpan).forEach(function (cell) {
                cells.add(cell);
            });
        });
        if (!cellsConnected(cells)) {
            return { ok: false, error: 'I tavoli uniti devono restare adiacenti.' };
        }

        const newColSpan = Math.max.apply(null, rects.map(function (rect) {
            return rect.dCol + rect.colSpan;
        }));
        const newRowSpan = Math.max.apply(null, rects.map(function (rect) {
            return rect.dRow + rect.rowSpan;
        }));

        const exclude = new Set([itemKey('group', group.id)]);
        let origin = null;

        if (rectFits(room, groupItem.col, groupItem.row, newColSpan, newRowSpan, exclude)) {
            origin = { col: groupItem.col, row: groupItem.row };
        } else {
            origin = findNearestFreeOrigin(
                room,
                groupItem.col,
                groupItem.row,
                newColSpan,
                newRowSpan,
                exclude
            );
        }

        if (!origin) {
            return {
                ok: false,
                error: 'Spazio insufficiente: libera spazio nella sala per allargare il gruppo.'
            };
        }

        group.offsets = rects;
        groupItem.col = origin.col;
        groupItem.row = origin.row;
        groupItem.colSpan = newColSpan;
        groupItem.rowSpan = newRowSpan;
        table.seats = seats;

        saveState();
        renderRooms();
        renderSummary();
        renderSelectionUI();
        return { ok: true, table: table };
    }

    function commitSeatInput(input) {
        const table = getTable(Number(input.dataset.tableId));
        if (!table) return;
        const result = applyTableSeats(table.id, Number(input.value));
        if (!result.ok) {
            showSeatError(result.error);
            input.value = String(table.seats);
            return;
        }
        syncForm();
        const next = document.querySelector('.seat-input[data-table-id="' + table.id + '"]');
        if (next) {
            next.focus();
            next.select();
        }
    }

    function stepTableSeats(tableId, delta) {
        const table = getTable(tableId);
        if (!table) return;
        const result = applyTableSeats(table.id, table.seats + delta);
        if (!result.ok) {
            showSeatError(result.error);
            return;
        }
        syncForm();
        const next = document.querySelector('.seat-input[data-table-id="' + table.id + '"]');
        if (next) next.focus();
    }

    /* ---------- Interactions: selection ---------- */

    function toggleSelection(entity) {
        const alreadySelected = isSelected(entity);
        const roomId = entityRoomId(entity.kind, entity.id);

        if (alreadySelected) {
            selection = selection.filter(function (s) {
                return !(s.kind === entity.kind && s.id === entity.id);
            });
        } else if (editReservationId !== null || editRoomsMode) {
            // In modifica prenotazione o modifica sale il tavolo si cambia, non si aggiunge.
            selection = [{ kind: entity.kind, id: entity.id }];
        } else if (entity.kind === 'group' || selection.some(function (s) {
            return s.kind === 'group' || entityRoomId(s.kind, s.id) !== roomId;
        })) {
            selection = [{ kind: entity.kind, id: entity.id }];
        } else {
            selection = selection.concat([{ kind: entity.kind, id: entity.id }]);
        }

        renderRooms();
        renderSelectionUI();
        syncForm();
    }

    function clearSelection() {
        selection = [];
    }

    /* ---------- Interactions: permanent room setup ---------- */

    function tableReservations(tableId) {
        return state.reservations.filter(function (reservation) {
            return !!reservation.target &&
                reservation.target.kind === 'table' &&
                reservation.target.id === tableId;
        });
    }

    function toggleEditRooms() {
        if (!editRoomsMode) {
            if (state.groups.length) {
                nudge(els.editRoomsBtn);
                toast(
                    'Separa i tavoli uniti prima di modificare le sale: la configurazione contiene solo i tavoli singoli.',
                    'warning'
                );
                return;
            }

            editRoomsMode = true;
            moveMode = false;
            movePicked = null;
            assigningReservationId = null;
            if (editReservationId !== null) resetEditState();
            clearSelection();
            renderAll();
            toast(
                'Modifica sale attiva: aggiungi o elimina tavoli, cambia i posti e usa “Sposta tavoli” per la disposizione. Le modifiche restano anche dopo “Ripristina sala”.',
                'info'
            );
            return;
        }

        editRoomsMode = false;
        moveMode = false;
        movePicked = null;
        clearSelection();
        renderAll();
        toast('Modifica sale terminata: “Ripristina sala” manterrà la disposizione salvata.', 'success');
    }

    function findFirstFreeOrigin(room) {
        for (let row = 1; row <= room.rows; row++) {
            for (let col = 1; col <= room.cols; col++) {
                if (rectFits(room, col, row, 1, 1, new Set())) {
                    return { col: col, row: row };
                }
            }
        }
        return null;
    }

    function smallestFreeTableId() {
        const used = new Set(state.tables.map(function (table) { return table.id; }));
        let id = 1;
        while (used.has(id)) id++;
        return id;
    }

    function orderedTableItems() {
        const items = [];
        state.rooms.forEach(function (room) {
            room.layout
                .filter(function (item) { return item.kind === 'table'; })
                .slice()
                .sort(function (a, b) {
                    if (a.row !== b.row) return a.row - b.row;
                    return a.col - b.col;
                })
                .forEach(function (item) { items.push(item); });
        });
        return items;
    }

    function renumberTables() {
        if (state.groups.length) {
            toast('Separa i tavoli uniti prima di rinumerare.', 'warning');
            return false;
        }

        const items = orderedTableItems();
        if (!items.length) return false;

        const map = new Map();
        items.forEach(function (item, index) {
            map.set(item.id, index + 1);
        });

        let changed = false;
        items.forEach(function (item) {
            const next = map.get(item.id);
            if (next !== item.id) changed = true;
            item.id = next;
        });

        state.tables.forEach(function (table) {
            const next = map.get(table.id);
            if (next) table.id = next;
        });

        state.reservations.forEach(function (reservation) {
            if (!reservation.target || reservation.target.kind !== 'table') return;
            const next = map.get(reservation.target.id);
            if (next) reservation.target.id = next;
        });

        selection = selection.map(function (entity) {
            if (entity.kind !== 'table') return entity;
            return { kind: entity.kind, id: map.get(entity.id) || entity.id };
        });

        if (movePicked && movePicked.kind === 'table') {
            movePicked = { kind: movePicked.kind, id: map.get(movePicked.id) || movePicked.id };
        }

        state.nextTableId = state.tables.reduce(function (max, table) {
            return Math.max(max, table.id);
        }, 0) + 1;

        saveState();
        saveConfig();
        renderAll();
        toast(
            changed
                ? 'Tavoli rinumerati da T1 a T' + state.tables.length + ': numerazione continua.'
                : 'La numerazione è già continua da T1 a T' + state.tables.length + '.',
            changed ? 'success' : 'info'
        );
        return true;
    }

    function requestRenumber(button) {
        if (state.groups.length) {
            nudge(button);
            toast('Separa i tavoli uniti prima di rinumerare.', 'warning');
            return;
        }

        if (button.dataset.confirming === '1') {
            window.clearTimeout(renumberTimer);
            button.dataset.confirming = '0';
            button.classList.remove('is-danger');
            renumberTables();
            return;
        }

        button.dataset.confirming = '1';
        button.classList.add('is-danger');
        button.textContent = 'Conferma rinumerazione';
        renumberTimer = window.setTimeout(function () {
            button.dataset.confirming = '0';
            button.classList.remove('is-danger');
            button.textContent = 'Rinumera tavoli';
        }, 3500);
    }

    function addTableToRoom(roomId) {
        if (!editRoomsMode) return;

        const room = getRoom(roomId);
        if (!room) return;

        const origin = findFirstFreeOrigin(room);
        if (!origin) {
            nudge(els.rooms);
            toast('Nessuna cella libera in ' + room.name + ': sposta o elimina un tavolo.', 'warning');
            return;
        }

        const id = smallestFreeTableId();
        state.nextTableId = id + 1;
        room.layout.push({
            kind: 'table',
            id: id,
            col: origin.col,
            row: origin.row,
            colSpan: 1,
            rowSpan: 1
        });
        state.tables.push({
            id: id,
            seats: 3,
            groupId: null,
            roomId: room.id
        });

        selection = [{ kind: 'table', id: id }];
        saveState();
        saveConfig();
        renderAll();
        toast(
            'Tavolo T' + id + ' aggiunto in ' + room.name + ' con 3 posti: regola i posti dal pannello.',
            'success'
        );
    }

    function requestDeleteTable(tableId, button) {
        const table = getTable(tableId);
        if (!table) return;

        if (tableReservations(tableId).length) {
            nudge(button);
            toast('Il tavolo ha prenotazioni: annullale per eliminarlo.', 'warning');
            return;
        }

        if (button.dataset.confirming === '1') {
            window.clearTimeout(deleteTableTimer);
            deleteTable(table);
            return;
        }

        button.dataset.confirming = '1';
        button.classList.add('is-danger');
        button.textContent = 'Conferma eliminazione';
        deleteTableTimer = window.setTimeout(function () {
            button.dataset.confirming = '0';
            button.classList.remove('is-danger');
            button.textContent = 'Elimina tavolo';
        }, 3500);
    }

    function deleteTable(table) {
        const room = getRoom(table.roomId);
        if (!room) return;

        if (state.tables.length <= 1) {
            toast('Deve restare almeno un tavolo.', 'warning');
            return;
        }

        room.layout = room.layout.filter(function (item) {
            return !(item.kind === 'table' && item.id === table.id);
        });
        state.tables = state.tables.filter(function (entry) {
            return entry.id !== table.id;
        });
        selection = selection.filter(function (entry) {
            return !(entry.kind === 'table' && entry.id === table.id);
        });
        state.nextTableId = state.tables.reduce(function (max, entry) {
            return Math.max(max, entry.id);
        }, 0) + 1;

        saveState();
        saveConfig();
        renderAll();
        toast(
            'Tavolo T' + table.id + ' eliminato: il numero T' + table.id + ' tornerà disponibile.',
            'success'
        );
    }

    function requestFactorySetup(button) {
        if (state.reservations.length) {
            nudge(button);
            toast(
                'Per ripristinare la disposizione iniziale annulla prima le prenotazioni.',
                'warning'
            );
            return;
        }

        if (button.dataset.confirming === '1') {
            window.clearTimeout(deleteTableTimer);
            applySetup(defaultSetup());
            saveConfig();
            saveState();
            selection = [];
            renderAll();
            toast('Disposizione iniziale ripristinata e salvata.', 'success');
            return;
        }

        button.dataset.confirming = '1';
        button.classList.add('is-danger');
        button.textContent = 'Conferma disposizione iniziale';
        deleteTableTimer = window.setTimeout(function () {
            button.dataset.confirming = '0';
            button.classList.remove('is-danger');
            button.textContent = 'Ripristina disposizione iniziale';
        }, 3500);
    }

    /* ---------- Interactions: combine / separate ---------- */

    function onCombine() {
        if (editRoomsMode) {
            nudge(els.combineBtn);
            toast(
                'In modifica sale i tavoli non si uniscono: termina la modifica e usa “Unisci tavoli”.',
                'info'
            );
            return;
        }

        if (selection.some(function (s) { return s.kind === 'group'; })) {
            nudge(els.combineBtn);
            toast('Un gruppo è già un tavolo unico: separalo prima di unirlo ad altri tavoli.', 'warning');
            return;
        }

        if (selection.length === 0) {
            nudge(els.combineBtn);
            toast('Seleziona due o più tavoli per creare un gruppo.', 'info');
            return;
        }

        if (selection.length === 1) {
            nudge(els.combineBtn);
            toast('Serve almeno un secondo tavolo per creare un gruppo.', 'info');
            return;
        }

        if (selection.length > MAX_GROUP) {
            nudge(els.combineBtn);
            toast('Puoi unire al massimo ' + MAX_GROUP + ' tavoli alla volta.', 'warning');
            return;
        }

        const tables = selection.map(function (s) { return getTable(s.id); }).filter(Boolean);
        const ids = tables.map(function (t) { return t.id; });
        const roomId = ids.length ? entityRoomId('table', ids[0]) : null;
        const room = getRoom(roomId);

        if (!room) return;

        if (ids.some(function (id) { return entityRoomId('table', id) !== roomId; })) {
            nudge(els.combineBtn);
            toast('I tavoli devono appartenere alla stessa sala per essere uniti.', 'warning');
            return;
        }

        if (tables.some(function (t) { return t.groupId !== null; })) {
            nudge(els.combineBtn);
            toast('Alcuni tavoli fanno già parte di un gruppo: separa prima quel gruppo.', 'warning');
            return;
        }

        if (tables.some(function (t) { return !!activeReservation('table', t.id); })) {
            nudge(els.combineBtn);
            toast('Uno dei tavoli è prenotato in questo slot: annulla la prenotazione per unirlo.', 'warning');
            return;
        }

        // Un tavolo con prenotazioni in altri slot non può entrare in un gruppo:
        // la prenotazione resterebbe orfana quando lo slot non è visualizzato.
        const otherSlotReservation = state.reservations.find(function (r) {
            return r.target && r.target.kind === 'table' && ids.indexOf(r.target.id) !== -1;
        });
        if (otherSlotReservation) {
            nudge(els.combineBtn);
            toast(
                'Un tavolo selezionato ha una prenotazione il ' +
                formatDate(otherSlotReservation.date) + ' alle ' + otherSlotReservation.time +
                ': annullala per unirlo.',
                'warning'
            );
            return;
        }

        const plan = buildGroupPlan();
        if (!plan) {
            nudge(els.combineBtn);
            toast(
                'Per unire i tavoli devono essere adiacenti e il blocco non deve contenere altri tavoli.',
                'warning'
            );
            return;
        }

        const group = {
            id: state.nextGroupId++,
            memberIds: plan.ids,
            roomId: plan.room.id,
            offsets: plan.locations.map(function (loc) {
                return {
                    id: loc.item.id,
                    dCol: loc.item.col - plan.col,
                    dRow: loc.item.row - plan.row,
                    colSpan: loc.item.colSpan,
                    rowSpan: loc.item.rowSpan
                };
            })
        };

        plan.room.layout = plan.room.layout.filter(function (item) {
            return !(item.kind === 'table' && plan.ids.indexOf(item.id) !== -1);
        });

        plan.room.layout.push({
            kind: 'group',
            id: group.id,
            col: plan.col,
            row: plan.row,
            colSpan: plan.colSpan,
            rowSpan: plan.rowSpan
        });

        state.groups.push(group);
        plan.ids.forEach(function (id) {
            const table = getTable(id);
            if (table) table.groupId = group.id;
        });

        selection = [{ kind: 'group', id: group.id }];
        saveState();
        renderAll();
        toast(
            'Tavoli T' + plan.ids.join(' + T') + ' uniti in un unico tavolo da ' +
            plan.totalSeats + ' posti (' + plan.room.name + ').',
            'success'
        );
    }

    function onSeparate() {
        if (selection.length !== 1 || selection[0].kind !== 'group') {
            nudge(els.separateBtn);
            toast('Seleziona un gruppo nella pianta per separarlo nei tavoli singoli.', 'info');
            return;
        }

        const group = getGroup(selection[0].id);
        if (!group) return;

        const location = entityLocation('group', group.id);
        if (!location) return;
        const room = location.room;
        const groupItem = location.item;

        // Il gruppo è un'entità unica in tutti gli slot: per separarlo
        // non deve avere prenotazioni in nessun orario.
        const groupReservation = state.reservations.find(function (r) {
            return r.target && r.target.kind === 'group' && r.target.id === group.id;
        });
        if (groupReservation) {
            nudge(els.separateBtn);
            toast(
                'Il gruppo ha una prenotazione il ' + formatDate(groupReservation.date) +
                ' alle ' + groupReservation.time + ': annullala per separarlo.',
                'warning'
            );
            return;
        }

        room.layout = room.layout.filter(function (item) {
            return !(item.kind === 'group' && item.id === group.id);
        });

        group.memberIds.forEach(function (tableId) {
            const offset = (group.offsets || []).find(function (entry) {
                return entry.id === tableId;
            }) || { dCol: 0, dRow: 0, colSpan: 1, rowSpan: 1 };

            let targetCol = groupItem.col + offset.dCol;
            let targetRow = groupItem.row + offset.dRow;

            if (!rectFits(room, targetCol, targetRow, offset.colSpan, offset.rowSpan, null)) {
                const free = findNearestFreeOrigin(
                    room,
                    targetCol,
                    targetRow,
                    offset.colSpan,
                    offset.rowSpan,
                    null
                );
                if (!free) return;
                targetCol = free.col;
                targetRow = free.row;
            }

            room.layout.push({
                kind: 'table',
                id: tableId,
                col: targetCol,
                row: targetRow,
                colSpan: offset.colSpan,
                rowSpan: offset.rowSpan
            });

            const table = getTable(tableId);
            if (table) {
                table.groupId = null;
                table.roomId = room.id;
            }
        });

        const totalSeats = groupSeats(group);
        state.groups = state.groups.filter(function (g) { return g.id !== group.id; });
        selection = [];
        saveState();
        renderAll();
        toast(
            'Gruppo separato: i tavoli T' + group.memberIds.join(', T') +
            ' tornano singoli (' + totalSeats + ' posti totali, ' + room.name + ').',
            'success'
        );
    }

    /* ---------- Interactions: free move ---------- */

    function onMoveToggle() {
        assigningReservationId = null;
        if (editReservationId !== null) resetEditState();

        if (moveMode) {
            moveMode = false;
            movePicked = null;
            renderAll();
            toast('Modalità spostamento chiusa.', 'info');
            return;
        }

        moveMode = true;
        movePicked = null;
        clearSelection();
        renderAll();
        toast('Spostamento: scegli un tavolo, poi una cella libera o un altro tavolo, anche in un\'altra sala.', 'info');
    }

    function handleMovePick(entity) {
        if (!movePicked) {
            movePicked = { kind: entity.kind, id: entity.id };
            renderRooms();
            renderSelectionUI();
            return;
        }

        if (movePicked.kind === entity.kind && movePicked.id === entity.id) {
            movePicked = null;
            renderRooms();
            renderSelectionUI();
            return;
        }

        const from = entityLocation(movePicked.kind, movePicked.id);
        const to = entityLocation(entity.kind, entity.id);
        if (!from || !to) {
            movePicked = null;
            renderAll();
            toast('Entità non disponibile: scegli un altro tavolo.', 'warning');
            return;
        }

        const sourceEntity = { kind: movePicked.kind, id: movePicked.id };
        const targetEntity = { kind: entity.kind, id: entity.id };
        const sourceItem = from.item;
        const targetItem = to.item;
        const exclude = new Set([
            itemKey(sourceItem.kind, sourceItem.id),
            itemKey(targetItem.kind, targetItem.id)
        ]);

        const sourceNew = {
            col: targetItem.col,
            row: targetItem.row,
            colSpan: sourceItem.colSpan,
            rowSpan: sourceItem.rowSpan
        };
        const targetNew = {
            col: sourceItem.col,
            row: sourceItem.row,
            colSpan: targetItem.colSpan,
            rowSpan: targetItem.rowSpan
        };

        const sameRoom = from.room.id === to.room.id;

        const sourceOk = rectFits(
            to.room,
            sourceNew.col,
            sourceNew.row,
            sourceNew.colSpan,
            sourceNew.rowSpan,
            exclude
        );
        const targetOk = rectFits(
            from.room,
            targetNew.col,
            targetNew.row,
            targetNew.colSpan,
            targetNew.rowSpan,
            exclude
        );
        const overlap = sameRoom && rectsOverlap(sourceNew, targetNew);

        if (!sourceOk || !targetOk || overlap) {
            nudge(els.statusLine);
            toast('Spazio insufficiente per lo scambio: scegli un altro tavolo o una cella libera.', 'warning');
            renderRooms();
            renderSelectionUI();
            return;
        }

        sourceItem.col = sourceNew.col;
        sourceItem.row = sourceNew.row;
        targetItem.col = targetNew.col;
        targetItem.row = targetNew.row;

        if (from.room.id !== to.room.id) {
            from.room.layout = from.room.layout.filter(function (item) {
                return item !== sourceItem;
            });
            to.room.layout = to.room.layout.filter(function (item) {
                return item !== targetItem;
            });
            to.room.layout.push(sourceItem);
            from.room.layout.push(targetItem);
        }

        setEntityRoom(sourceEntity.kind, sourceEntity.id, to.room.id);
        setEntityRoom(targetEntity.kind, targetEntity.id, from.room.id);

        movePicked = null;
        saveState();
        if (editRoomsMode) saveConfig();
        renderAll();

        if (sameRoom) {
            toast(shortName(sourceEntity) + ' e ' + shortName(targetEntity) + ' hanno scambiato posizione. Scegli il prossimo tavolo.', 'success');
        } else {
            toast(
                shortName(sourceEntity) + ' e ' + shortName(targetEntity) +
                ' hanno scambiato posto tra ' + from.room.name + ' e ' + to.room.name +
                '. Scegli il prossimo tavolo.',
                'success'
            );
        }
    }

    function handleGapClick(roomId, clickCol, clickRow) {
        if (!moveMode) return;

        if (!movePicked) {
            toast('Prima scegli il tavolo o il gruppo da spostare.', 'info');
            return;
        }

        const from = entityLocation(movePicked.kind, movePicked.id);
        const room = getRoom(roomId);
        if (!from || !room) return;

        const exclude = new Set([itemKey(from.item.kind, from.item.id)]);
        const origin = findFreeOrigin(
            room,
            clickCol,
            clickRow,
            from.item.colSpan,
            from.item.rowSpan,
            exclude
        );

        if (!origin) {
            nudge(els.statusLine);
            toast('Spazio insufficiente in questa posizione: scegli un\'altra cella.', 'warning');
            return;
        }

        const movedEntity = { kind: from.item.kind, id: from.item.id };
        const movedName = shortName(movedEntity);

        from.room.layout = from.room.layout.filter(function (item) {
            return item !== from.item;
        });
        from.item.col = origin.col;
        from.item.row = origin.row;
        room.layout.push(from.item);
        setEntityRoom(movedEntity.kind, movedEntity.id, room.id);

        movePicked = null;
        saveState();
        if (editRoomsMode) saveConfig();
        renderAll();
        toast(movedName + ' spostato in ' + room.name + '. Scegli il prossimo tavolo.', 'success');
    }

    /* ---------- Interactions: edit a reservation ---------- */

    function resetEditState() {
        editReservationId = null;
        els.guestName.value = '';
        els.guestPhone.value = '';
        els.guestCount.value = '';
        els.guestNote.value = '';
        clearAllFieldErrors();
    }

    function cancelEdit() {
        if (editReservationId === null) return;
        resetEditState();
        selection = [];
        renderAll();
        if (isMobileLayout()) setTab('prenotazioni');
        toast('Modifica annullata.', 'info');
    }

    function startEdit(reservationId) {
        const reservation = getReservation(reservationId);
        if (!reservation) return;

        if (editRoomsMode) {
            editRoomsMode = false;
        }

        editReservationId = reservation.id;
        assigningReservationId = null;
        moveMode = false;
        movePicked = null;

        selection = reservation.target
            ? [{ kind: reservation.target.kind, id: reservation.target.id }]
            : [];

        els.date.value = reservation.date;
        setTimeValue(els.time, reservation.time);
        syncSlotFields();

        els.guestName.value = reservation.name;
        els.guestPhone.value = reservation.phone || '';
        els.guestCount.value = String(reservation.guests);
        els.guestNote.value = reservation.note || '';

        renderAll();
        if (isMobileLayout()) {
            setTab('nuova');
        } else {
            els.guestName.focus();
        }
        toast('Modifica della prenotazione di ' + reservation.name + '.', 'info');
    }

    /* ---------- Interactions: assign a table later ---------- */

    function reservationAtSlot(kind, id, date, time) {
        return state.reservations.find(function (reservation) {
            return reservation.target &&
                reservation.target.kind === kind &&
                reservation.target.id === id &&
                reservation.date === date &&
                reservation.time === time;
        }) || null;
    }

    function startAssign(reservationId) {
        const reservation = getReservation(reservationId);
        if (!reservation || reservation.target) return;

        if (editRoomsMode) {
            editRoomsMode = false;
        }

        assigningReservationId = reservationId;
        resetEditState();
        moveMode = false;
        movePicked = null;
        clearSelection();
        renderAll();
        if (isMobileLayout()) setTab('sala');
        toast(
            'Prenotazione di ' + reservation.name + ': scegli un tavolo o un gruppo libero ' +
            'con almeno ' + reservation.guests + ' posti.',
            'info'
        );
    }

    function assignReservationToEntity(entity) {
        const reservation = getReservation(assigningReservationId);
        if (!reservation) {
            assigningReservationId = null;
            renderAll();
            return;
        }

        const capacity = entitySeats(entity);
        if (capacity < reservation.guests) {
            nudge(els.statusLine);
            toast(
                'Capienza insufficiente: ' + shortName(entity) + ' ha ' + capacity +
                ' posti, servono ' + reservation.guests + '.',
                'warning'
            );
            return;
        }

        if (reservationAtSlot(entity.kind, entity.id, reservation.date, reservation.time)) {
            nudge(els.statusLine);
            toast(shortName(entity) + ' è già prenotato in questo slot: scegli un altro tavolo.', 'warning');
            return;
        }

        reservation.target = { kind: entity.kind, id: entity.id };
        assigningReservationId = null;
        saveState();
        renderAll();
        if (isMobileLayout()) setTab('prenotazioni');
        toast(
            'Prenotazione di ' + reservation.name + ' assegnata a ' + shortName(entity) + '.',
            'success'
        );
    }

    /* ---------- Interactions: reservation form ---------- */

    function fieldErrorId(input) {
        return input.id + 'Error';
    }

    function setFieldError(input, message) {
        const error = document.getElementById(fieldErrorId(input));
        if (error) error.textContent = message || '';
        input.classList.toggle('invalid', !!message);
        if (message) {
            input.setAttribute('aria-invalid', 'true');
        } else {
            input.removeAttribute('aria-invalid');
        }
    }

    function clearFieldError(input) {
        setFieldError(input, '');
    }

    function clearAllFieldErrors() {
        [els.formDate, els.formTime, els.guestName, els.guestPhone, els.guestCount]
            .forEach(clearFieldError);
    }

    function onSubmit(event) {
        event.preventDefault();
        clearAllFieldErrors();

        let firstInvalid = null;

        const dateIso = parseDateText(els.formDate.value);
        const timeValue = parseTimeText(els.formTime.value);

        if (!dateIso) {
            setFieldError(els.formDate, 'Scegli una data valida.');
            firstInvalid = firstInvalid || els.formDate;
        }

        if (!timeValue) {
            setFieldError(els.formTime, 'Inserisci un orario valido (hh:mm).');
            firstInvalid = firstInvalid || els.formTime;
        }

        if (dateIso && timeValue) {
            els.date.value = dateIso;
            setTimeValue(els.time, timeValue);
            els.formDate.value = dateIso;
            setTimeValue(els.formTime, timeValue);
        }

        const name = els.guestName.value.trim();
        const phone = els.guestPhone.value.trim();
        const guests = Number(els.guestCount.value);
        const note = els.guestNote.value.trim();

        if (name.length < 2) {
            setFieldError(els.guestName, 'Inserisci nome e cognome del cliente.');
            firstInvalid = firstInvalid || els.guestName;
        }

        if (phone && phone.replace(/\D/g, '').length < 6) {
            setFieldError(els.guestPhone, 'Inserisci un telefono valido (almeno 6 cifre) oppure lascia vuoto.');
            firstInvalid = firstInvalid || els.guestPhone;
        }

        const single = selection.length === 1 ? selection[0] : null;
        const capacity = single ? entitySeats(single) : totalCapacity();
        const multiSelection = selection.length > 1;
        let editingReservation = editReservationId !== null ? getReservation(editReservationId) : null;
        if (editReservationId !== null && !editingReservation) {
            editReservationId = null;
        }

        const conflict = single && dateIso && timeValue
            ? reservationAtSlot(single.kind, single.id, dateIso, timeValue)
            : null;
        const hasConflict = !!conflict &&
            (!editingReservation || conflict.id !== editingReservation.id);

        if (!Number.isInteger(guests) || guests < 1) {
            setFieldError(els.guestCount, 'Indica almeno 1 ospite.');
            firstInvalid = firstInvalid || els.guestCount;
        } else if (guests > capacity) {
            setFieldError(els.guestCount, capacityError(capacity, !!single));
            firstInvalid = firstInvalid || els.guestCount;
        }

        if (hasConflict) {
            nudge(els.targetInfo);
            toast(fullName(single) + ' è già prenotato in questo slot.', 'warning');
        }

        if (firstInvalid) {
            nudge(els.createBtn);
            firstInvalid.focus();
            return;
        }

        if (multiSelection) {
            nudge(els.targetInfo);
            toast(
                'Hai selezionato più tavoli: uniscili o selezionane uno. ' +
                'Per prenotare senza tavolo, deseleziona tutto.',
                'info'
            );
            return;
        }

        if (!dateIso || !timeValue) return;
        if (hasConflict) return;

        if (editingReservation) {
            editingReservation.name = name;
            editingReservation.phone = phone;
            editingReservation.guests = guests;
            editingReservation.note = note;
            editingReservation.date = dateIso;
            editingReservation.time = timeValue;
            editingReservation.target = single
                ? { kind: single.kind, id: single.id }
                : null;

            resetEditState();
            saveState();
            selection = [];
            renderAll();
            toast('Prenotazione di ' + name + ' aggiornata.', 'success');
            if (isMobileLayout()) {
                setTab('prenotazioni');
            } else {
                els.guestName.focus();
            }
            return;
        }

        state.reservations.push({
            id: state.nextReservationId++,
            name: name,
            phone: phone,
            guests: guests,
            note: note,
            date: dateIso,
            time: timeValue,
            target: single ? { kind: single.kind, id: single.id } : null
        });

        saveState();
        els.guestName.value = '';
        els.guestPhone.value = '';
        els.guestCount.value = '';
        els.guestNote.value = '';
        selection = [];
        renderAll();
        toast(
            single
                ? 'Prenotazione creata per ' + name + ' · ' + guests + ' ospiti, ' +
                  shortName(single) + ' alle ' + timeValue + '.'
                : 'Prenotazione creata per ' + name + ' · ' + guests +
                  ' ospiti, senza tavolo. Assegnalo dalla lista.',
            'success'
        );
        if (isMobileLayout()) {
            setTab('prenotazioni');
        } else {
            els.guestName.focus();
        }
    }

    function requestCancel(reservationId, button) {
        if (button.dataset.confirming === '1') {
            cancelReservation(reservationId);
            return;
        }

        clearCancelConfirmations();

        button.dataset.confirming = '1';
        button.classList.add('confirming');
        button.textContent = 'Conferma';
        button._timer = window.setTimeout(function () {
            resetCancelButton(button);
        }, 3500);
    }

    function resetCancelButton(button) {
        if (button._timer) {
            window.clearTimeout(button._timer);
            button._timer = null;
        }
        if (!button.isConnected) return;
        button.dataset.confirming = '0';
        button.classList.remove('confirming');
        button.textContent = 'Annulla';
    }

    function clearCancelConfirmations() {
        els.reservationList.querySelectorAll('.btn-cancel').forEach(function (button) {
            if (button.dataset.confirming === '1') resetCancelButton(button);
        });
    }

    function cancelReservation(reservationId) {
        const reservation = state.reservations.find(function (r) {
            return r.id === reservationId;
        });
        if (!reservation) return;

        if (editReservationId === reservationId) resetEditState();
        if (assigningReservationId === reservationId) assigningReservationId = null;

        state.reservations = state.reservations.filter(function (r) {
            return r.id !== reservationId;
        });

        saveState();
        renderAll();
        toast('Prenotazione di ' + reservation.name + ' annullata.', 'success');
    }

    /* ---------- Reset ---------- */

    function onReset() {
        if (els.resetBtn.dataset.confirming === '1') {
            window.clearTimeout(resetTimer);
            els.resetBtn.dataset.confirming = '0';
            els.resetBtn.classList.remove('is-danger');
            els.resetBtn.textContent = 'Ripristina sala';

            buildFreshState();
            selection = [];
            moveMode = false;
            movePicked = null;
            assigningReservationId = null;
            editReservationId = null;
            editRoomsMode = false;
            els.guestName.value = '';
            els.guestPhone.value = '';
            els.guestCount.value = '';
            els.guestNote.value = '';
            clearAllFieldErrors();
            syncSlotFields();
            saveState();
            renderAll();
            toast(
                loadConfig()
                    ? 'Sala ripristinata sulla configurazione salvata.'
                    : 'Sala ripristinata con lo schema delle due sale.',
                'success'
            );
            return;
        }

        els.resetBtn.dataset.confirming = '1';
        els.resetBtn.classList.add('is-danger');
        els.resetBtn.textContent = 'Conferma ripristino';
        resetTimer = window.setTimeout(function () {
            els.resetBtn.dataset.confirming = '0';
            els.resetBtn.classList.remove('is-danger');
            els.resetBtn.textContent = 'Ripristina sala';
        }, 3500);
    }

    /* ---------- Typed date & time ---------- */

    function todayIso() {
        const now = new Date();
        const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
        return local.toISOString().slice(0, 10);
    }

    function pad(value) {
        return String(value).padStart(2, '0');
    }

    function formatDate(iso) {
        if (!iso) return '—';
        const date = new Date(iso + 'T00:00:00');
        if (isNaN(date.getTime())) return iso;
        return date.toLocaleDateString('it-IT', {
            weekday: 'short',
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        });
    }

    function parseDateText(raw) {
        const value = String(raw || '').trim();
        if (!value) return null;

        let day;
        let month;
        let year;
        let match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);

        if (match) {
            year = Number(match[1]);
            month = Number(match[2]);
            day = Number(match[3]);
        } else {
            match = value.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/);
            if (!match) return null;
            day = Number(match[1]);
            month = Number(match[2]);
            year = match[3] === undefined ? new Date().getFullYear() : Number(match[3]);
            if (year < 100) year += 2000;
        }

        if (year < 2000 || year > 2100) return null;
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;

        const date = new Date(year, month - 1, day);
        if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
            return null;
        }

        return year + '-' + pad(month) + '-' + pad(day);
    }

    function parseTimeText(raw) {
        const value = String(raw || '').trim().replace(',', ':').replace('.', ':');
        if (!value) return null;

        let hours;
        let minutes;
        let match = value.match(/^(\d{1,2}):(\d{1,2})$/);

        if (match) {
            hours = Number(match[1]);
            minutes = Number(match[2]);
        } else if (/^\d{3,4}$/.test(value)) {
            hours = Number(value.slice(0, -2));
            minutes = Number(value.slice(-2));
        } else if (/^\d{1,2}$/.test(value)) {
            hours = Number(value);
            minutes = 0;
        } else {
            return null;
        }

        if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
        return pad(hours) + ':' + pad(minutes);
    }

    function isCompleteDateText(value) {
        return /^(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})$/
            .test(String(value || '').trim());
    }

    function isCompleteTimeText(value) {
        return /^\d{1,2}[:.,]\d{2}$/.test(String(value || '').trim());
    }

    /* ---------- Time dropdown ---------- */

    const TIME_SLOTS = (function () {
        const list = [];
        for (let minutes = 11 * 60; minutes <= 23 * 60 + 45; minutes += 15) {
            list.push(pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60));
        }
        return list;
    })();

    function buildTimeOptions(select) {
        if (!select) return;
        const fragment = document.createDocumentFragment();
        TIME_SLOTS.forEach(function (time) {
            const option = document.createElement('option');
            option.value = time;
            option.textContent = time;
            fragment.appendChild(option);
        });
        select.replaceChildren(fragment);
        select.value = '20:00';
    }

    function setTimeValue(select, value) {
        const time = parseTimeText(value);
        if (!select || !time) return false;

        const reference = Array.prototype.find.call(select.options, function (option) {
            return option.value === time;
        });

        if (!reference) {
            const option = document.createElement('option');
            option.value = time;
            option.textContent = time;

            const times = Array.prototype.map.call(select.options, function (entry) {
                return entry.value;
            });
            times.push(time);
            times.sort();

            const nextValue = times[times.indexOf(time) + 1];
            const next = nextValue
                ? Array.prototype.find.call(select.options, function (entry) {
                    return entry.value === nextValue;
                })
                : null;
            select.insertBefore(option, next || null);
        }

        select.value = time;
        return true;
    }

    function applySlot(dateIso, timeValue) {
        const changed = els.date.value !== dateIso || els.time.value !== timeValue;
        els.date.value = dateIso;
        setTimeValue(els.time, timeValue);
        if (changed) renderAll();
    }

    function applyTypedSlotIfComplete() {
        if (!isCompleteDateText(els.formDate.value) || !isCompleteTimeText(els.formTime.value)) {
            return;
        }
        const dateIso = parseDateText(els.formDate.value);
        const timeValue = parseTimeText(els.formTime.value);
        if (!dateIso || !timeValue) return;
        applySlot(dateIso, timeValue);
    }

    function normalizeSlotField(input) {
        const raw = input.value.trim();

        if (!raw) {
            setFieldError(input, input === els.formDate
                ? 'Scegli una data.'
                : 'Inserisci un orario.');
            return;
        }

        if (input === els.formDate) {
            const iso = parseDateText(raw);
            if (!iso) {
                setFieldError(input, 'Data non valida.');
                return;
            }
            input.value = iso;
            clearFieldError(input);
        } else {
            const timeValue = parseTimeText(raw);
            if (!timeValue) {
                setFieldError(input, 'Ora non valida (hh:mm).');
                return;
            }
            input.value = timeValue;
            clearFieldError(input);
        }

        const dateIso = parseDateText(els.formDate.value);
        const timeValue = parseTimeText(els.formTime.value);
        if (dateIso && timeValue) applySlot(dateIso, timeValue);
    }

    function syncSlotFields() {
        els.formDate.value = els.date.value || todayIso();
        setTimeValue(els.formTime, els.time.value || '20:00');
        clearFieldError(els.formDate);
        clearFieldError(els.formTime);
    }

    function onHeaderSlotChange() {
        if (!els.date.value) els.date.value = todayIso();
        if (!els.time.value) setTimeValue(els.time, '20:00');
        assigningReservationId = null;
        syncSlotFields();
        clearCancelConfirmations();
        renderAll();
    }

    /* ---------- Feedback helpers ---------- */

    function nudge(element) {
        if (!element) return;
        element.classList.remove('shake');
        void element.offsetWidth;
        element.classList.add('shake');
        element.addEventListener('animationend', function () {
            element.classList.remove('shake');
        }, { once: true });
    }

    function toast(message, kind) {
        const node = document.createElement('div');
        node.className = 'toast toast-' + (kind || 'info');
        node.setAttribute('role', 'status');

        node.appendChild(el('span', 'toast-dot'));
        node.appendChild(el('span', 'toast-text', message));

        const close = el('button', 'toast-close', '×');
        close.type = 'button';
        close.setAttribute('aria-label', 'Chiudi notifica');
        close.addEventListener('click', function () {
            dismissToast(node);
        });
        node.appendChild(close);

        els.toastStack.appendChild(node);
        while (els.toastStack.children.length > 4) {
            els.toastStack.firstElementChild.remove();
        }

        requestAnimationFrame(function () {
            node.classList.add('is-visible');
        });

        let timer = window.setTimeout(function () {
            dismissToast(node);
        }, 4200);

        node.addEventListener('mouseenter', function () {
            window.clearTimeout(timer);
        });
        node.addEventListener('mouseleave', function () {
            timer = window.setTimeout(function () {
                dismissToast(node);
            }, 1800);
        });
    }

    function dismissToast(node) {
        if (!node || node.classList.contains('is-hiding')) return;
        node.classList.add('is-hiding');
        node.classList.remove('is-visible');
        window.setTimeout(function () {
            if (node.parentNode) node.parentNode.removeChild(node);
        }, 220);
    }

    /* ---------- Persistence ---------- */

    function saveState() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
                rooms: state.rooms,
                tables: state.tables,
                groups: state.groups,
                reservations: state.reservations,
                nextTableId: state.nextTableId,
                nextGroupId: state.nextGroupId,
                nextReservationId: state.nextReservationId
            }));
        } catch (error) {
            /* Storage non disponibile: l'app resta utilizzabile in memoria. */
        }
    }

    function loadState() {
        let data;
        try {
            data = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
        } catch (error) {
            return false;
        }

        if (!data || !Array.isArray(data.rooms) || !data.rooms.length ||
            !Array.isArray(data.tables) || !data.tables.length ||
            !Array.isArray(data.groups) || !Array.isArray(data.reservations)) {
            return false;
        }

        const tableIds = new Set();
        const tables = [];

        for (let i = 0; i < data.tables.length; i++) {
            const rawTable = data.tables[i];
            const id = Number(rawTable && rawTable.id);
            const seats = Number(rawTable && rawTable.seats);
            if (!Number.isInteger(id) || id < 1 || tableIds.has(id)) return false;
            if (!Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS) return false;
            tableIds.add(id);
            tables.push({ id: id, seats: seats, groupId: null, roomId: null });
        }

        const groups = [];
        const groupIds = new Set();
        const groupedTableIds = new Set();

        for (let i = 0; i < data.groups.length; i++) {
            const rawGroup = data.groups[i];
            const id = Number(rawGroup && rawGroup.id);
            if (!Number.isInteger(id) || groupIds.has(id)) return false;
            if (!rawGroup || !Array.isArray(rawGroup.memberIds) || rawGroup.memberIds.length < 2) {
                return false;
            }
            const members = rawGroup.memberIds.map(Number);
            if (members.some(function (tableId) {
                return !tableIds.has(tableId) || groupedTableIds.has(tableId);
            })) {
                return false;
            }
            if (!Array.isArray(rawGroup.offsets) ||
                rawGroup.offsets.length !== members.length) {
                return false;
            }

            const offsets = [];
            const offsetIds = new Set();
            for (let j = 0; j < rawGroup.offsets.length; j++) {
                const offset = rawGroup.offsets[j] || {};
                const offsetId = Number(offset.id);
                const dCol = Number(offset.dCol);
                const dRow = Number(offset.dRow);
                const colSpan = Number(offset.colSpan);
                const rowSpan = Number(offset.rowSpan);
                if (members.indexOf(offsetId) === -1 || offsetIds.has(offsetId)) return false;
                offsetIds.add(offsetId);
                if (!Number.isInteger(dCol) || dCol < 0 || dCol > 20) return false;
                if (!Number.isInteger(dRow) || dRow < 0 || dRow > 20) return false;
                if (!Number.isInteger(colSpan) || colSpan < 1 || colSpan > 6) return false;
                if (!Number.isInteger(rowSpan) || rowSpan < 1 || rowSpan > 6) return false;
                offsets.push({
                    id: offsetId,
                    dCol: dCol,
                    dRow: dRow,
                    colSpan: colSpan,
                    rowSpan: rowSpan
                });

                const memberTable = tables.find(function (table) { return table.id === offsetId; });
                if (!memberTable ||
                    !spanMatchesSeats({ colSpan: colSpan, rowSpan: rowSpan }, memberTable.seats)) {
                    return false;
                }
            }

            members.forEach(function (tableId) { groupedTableIds.add(tableId); });
            groupIds.add(id);
            groups.push({ id: id, memberIds: members, roomId: null, offsets: offsets });
        }

        const rooms = [];
        const roomIds = new Set();
        const seenEntities = new Set();
        const tableRooms = new Map();
        const groupRooms = new Map();

        for (let i = 0; i < data.rooms.length; i++) {
            const rawRoom = data.rooms[i];
            if (!rawRoom || typeof rawRoom !== 'object') return false;

            const id = String(rawRoom.id || '');
            if (!id || roomIds.has(id)) return false;

            const cols = Number(rawRoom.cols);
            const rows = Number(rawRoom.rows);
            if (!Number.isInteger(cols) || cols < 2 || cols > 12) return false;
            if (!Number.isInteger(rows) || rows < 1 || rows > 12) return false;

            if (!Array.isArray(rawRoom.layout)) return false;

            const layout = [];
            const occupied = new Set();

            for (let j = 0; j < rawRoom.layout.length; j++) {
                const item = rawRoom.layout[j];
                if (!item) return false;

                const kind = item.kind;
                if (kind !== 'table' && kind !== 'group') return false;

                const entityId = Number(item.id);
                if (!Number.isInteger(entityId) || entityId < 1) return false;

                if (kind === 'table' && (!tableIds.has(entityId) || groupedTableIds.has(entityId))) {
                    return false;
                }
                if (kind === 'group' && !groupIds.has(entityId)) return false;

                const key = itemKey(kind, entityId);
                if (seenEntities.has(key)) return false;

                const col = Number(item.col);
                const row = Number(item.row);
                const colSpan = Number(item.colSpan);
                const rowSpan = Number(item.rowSpan);
                if (!Number.isInteger(col) || col < 1 || col > cols) return false;
                if (!Number.isInteger(row) || row < 1 || row > rows) return false;
                if (!Number.isInteger(colSpan) || colSpan < 1 || colSpan > 6) return false;
                if (!Number.isInteger(rowSpan) || rowSpan < 1 || rowSpan > 6) return false;
                if (col + colSpan - 1 > cols || row + rowSpan - 1 > rows) return false;

                const cells = rectKeys(col, row, colSpan, rowSpan);
                if (cells.some(function (cell) { return occupied.has(cell); })) return false;
                cells.forEach(function (cell) { occupied.add(cell); });

                seenEntities.add(key);
                if (kind === 'table') {
                    const table = tables.find(function (t) { return t.id === entityId; });
                    if (!table ||
                        !spanMatchesSeats({ colSpan: colSpan, rowSpan: rowSpan }, table.seats)) {
                        return false;
                    }
                    tableRooms.set(entityId, id);
                } else {
                    const group = groups.find(function (g) { return g.id === entityId; });
                    if (!group) return false;
                    const offsetsFit = group.offsets.every(function (offset) {
                        return offset.dCol + offset.colSpan <= colSpan &&
                            offset.dRow + offset.rowSpan <= rowSpan;
                    });
                    if (!offsetsFit) return false;
                    const expectedColSpan = Math.max.apply(null, group.offsets.map(function (offset) {
                        return offset.dCol + offset.colSpan;
                    }));
                    const expectedRowSpan = Math.max.apply(null, group.offsets.map(function (offset) {
                        return offset.dRow + offset.rowSpan;
                    }));
                    if (expectedColSpan !== colSpan || expectedRowSpan !== rowSpan) return false;
                    groupRooms.set(entityId, id);
                }

                layout.push({
                    kind: kind,
                    id: entityId,
                    col: col,
                    row: row,
                    colSpan: colSpan,
                    rowSpan: rowSpan
                });
            }

            rooms.push({
                id: id,
                name: String(rawRoom.name || '').trim() || 'Sala',
                cols: cols,
                rows: rows,
                layout: layout
            });
            roomIds.add(id);
        }

        const tableGroup = new Map();
        groups.forEach(function (group) {
            group.memberIds.forEach(function (tableId) {
                tableGroup.set(tableId, group.id);
            });
        });

        const missingEntity = tables.some(function (table) {
            if (tableGroup.has(table.id)) {
                return !groupRooms.has(tableGroup.get(table.id));
            }
            return !tableRooms.has(table.id);
        });
        if (missingEntity) return false;
        if (groups.some(function (group) { return !groupRooms.has(group.id); })) return false;

        tables.forEach(function (table) {
            const groupId = tableGroup.get(table.id);
            if (groupId !== undefined) {
                table.groupId = groupId;
                table.roomId = groupRooms.get(groupId);
            } else {
                table.roomId = tableRooms.get(table.id);
            }
        });

        groups.forEach(function (group) {
            group.roomId = groupRooms.get(group.id);
        });

        if (tables.some(function (table) { return !table.roomId; }) ||
            groups.some(function (group) { return !group.roomId; })) {
            return false;
        }

        const reservations = [];
        const reservationIds = new Set();

        for (let i = 0; i < data.reservations.length; i++) {
            const rawReservation = data.reservations[i];
            if (!rawReservation) continue;

            const id = Number(rawReservation.id);
            if (!Number.isInteger(id) || id < 1 || reservationIds.has(id)) continue;

            const rawTarget = rawReservation.target;
            let capacity = 0;
            let target = null;

            if (rawTarget === null || rawTarget === undefined) {
                capacity = tables.reduce(function (total, table) {
                    return total + table.seats;
                }, 0);
            } else {
                const kind = rawTarget.kind;
                const targetId = Number(rawTarget.id);

                if (kind === 'table' && tableIds.has(targetId) && !groupedTableIds.has(targetId)) {
                    const table = tables.find(function (t) { return t.id === targetId; });
                    capacity = table ? table.seats : 0;
                    target = { kind: kind, id: targetId };
                } else if (kind === 'group' && groupIds.has(targetId)) {
                    const group = groups.find(function (g) { return g.id === targetId; });
                    capacity = group
                        ? group.memberIds.reduce(function (total, memberId) {
                            const member = tables.find(function (t) { return t.id === memberId; });
                            return total + (member ? member.seats : 0);
                        }, 0)
                        : 0;
                    target = { kind: kind, id: targetId };
                } else {
                    continue;
                }
            }

            const guests = Number(rawReservation.guests);
            if (!Number.isInteger(guests) || guests < 1 || guests > capacity) continue;

            const date = parseDateText(rawReservation.date);
            const time = parseTimeText(rawReservation.time);
            if (!date || !time) continue;

            reservationIds.add(id);
            reservations.push({
                id: id,
                name: String(rawReservation.name || 'Ospite'),
                phone: String(rawReservation.phone || ''),
                note: String(rawReservation.note || ''),
                guests: guests,
                date: date,
                time: time,
                target: target
            });
        }

        state.rooms = rooms;
        state.tables = tables;
        state.groups = groups;
        state.reservations = reservations;
        state.nextTableId = Math.max.apply(null, tables.map(function (t) { return t.id; })) + 1;
        state.nextGroupId = groups.length
            ? Math.max.apply(null, groups.map(function (g) { return g.id; })) + 1
            : 1;
        state.nextReservationId = reservations.length
            ? Math.max.apply(null, reservations.map(function (r) { return r.id; })) + 1
            : 1;

        return true;
    }

    /* ---------- Persistence: permanent room setup ---------- */

    function saveConfig() {
        // I gruppi sono temporanei: la configurazione contiene solo i tavoli base.
        if (state.groups.length) return;

        try {
            window.localStorage.setItem(CONFIG_KEY, JSON.stringify({
                rooms: state.rooms.map(function (room) {
                    return {
                        id: room.id,
                        name: room.name,
                        cols: room.cols,
                        rows: room.rows,
                        layout: room.layout
                            .filter(function (item) { return item.kind === 'table'; })
                            .map(function (item) {
                                return {
                                    kind: 'table',
                                    id: item.id,
                                    col: item.col,
                                    row: item.row,
                                    colSpan: item.colSpan,
                                    rowSpan: item.rowSpan
                                };
                            })
                    };
                }),
                tables: state.tables.map(function (table) {
                    return {
                        id: table.id,
                        seats: table.seats,
                        roomId: table.roomId
                    };
                })
            }));
        } catch (error) {
            /* Storage non disponibile: la configurazione resta solo in memoria. */
        }
    }

    function loadConfig() {
        let data;
        try {
            data = JSON.parse(window.localStorage.getItem(CONFIG_KEY) || 'null');
        } catch (error) {
            return null;
        }
        return sanitizeSetup(data);
    }

    function sanitizeSetup(data) {
        if (!data || !Array.isArray(data.rooms) || !data.rooms.length ||
            !Array.isArray(data.tables) || !data.tables.length) {
            return null;
        }

        const tables = [];
        const tableIds = new Set();

        for (let i = 0; i < data.tables.length; i++) {
            const rawTable = data.tables[i];
            const id = Number(rawTable && rawTable.id);
            const seats = Number(rawTable && rawTable.seats);
            if (!Number.isInteger(id) || id < 1 || tableIds.has(id)) return null;
            if (!Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS) return null;
            tableIds.add(id);
            tables.push({ id: id, seats: seats, roomId: null });
        }

        const rooms = [];
        const roomIds = new Set();
        const placed = new Set();

        for (let i = 0; i < data.rooms.length; i++) {
            const rawRoom = data.rooms[i];
            if (!rawRoom || typeof rawRoom !== 'object') return null;

            const id = String(rawRoom.id || '');
            if (!id || roomIds.has(id)) return null;

            const cols = Number(rawRoom.cols);
            const rows = Number(rawRoom.rows);
            if (!Number.isInteger(cols) || cols < 2 || cols > 12) return null;
            if (!Number.isInteger(rows) || rows < 1 || rows > 12) return null;
            if (!Array.isArray(rawRoom.layout)) return null;

            const occupied = new Set();
            const layout = [];

            for (let j = 0; j < rawRoom.layout.length; j++) {
                const item = rawRoom.layout[j];
                if (!item || item.kind !== 'table') return null;

                const entityId = Number(item.id);
                if (!tableIds.has(entityId) || placed.has(entityId)) return null;

                const col = Number(item.col);
                const row = Number(item.row);
                const colSpan = Number(item.colSpan);
                const rowSpan = Number(item.rowSpan);
                if (!Number.isInteger(col) || col < 1 || col > cols) return null;
                if (!Number.isInteger(row) || row < 1 || row > rows) return null;
                if (!Number.isInteger(colSpan) || colSpan < 1 || colSpan > 6) return null;
                if (!Number.isInteger(rowSpan) || rowSpan < 1 || rowSpan > 6) return null;
                if (col + colSpan - 1 > cols || row + rowSpan - 1 > rows) return null;

                const cells = rectKeys(col, row, colSpan, rowSpan);
                if (cells.some(function (cell) { return occupied.has(cell); })) return null;
                cells.forEach(function (cell) { occupied.add(cell); });

                const table = tables.find(function (t) { return t.id === entityId; });
                if (!table ||
                    !spanMatchesSeats({ colSpan: colSpan, rowSpan: rowSpan }, table.seats)) {
                    return null;
                }

                table.roomId = id;
                placed.add(entityId);
                layout.push({
                    kind: 'table',
                    id: entityId,
                    col: col,
                    row: row,
                    colSpan: colSpan,
                    rowSpan: rowSpan
                });
            }

            rooms.push({
                id: id,
                name: String(rawRoom.name || '').trim() || 'Sala',
                cols: cols,
                rows: rows,
                layout: layout
            });
            roomIds.add(id);
        }

        if (placed.size !== tables.length) return null;
        if (tables.some(function (table) { return !table.roomId; })) return null;

        return { rooms: rooms, tables: tables };
    }

    /* ---------- Events ---------- */

    function bindEvents() {
        els.date.addEventListener('change', onHeaderSlotChange);
        els.time.addEventListener('change', onHeaderSlotChange);

        els.combineBtn.addEventListener('click', onCombine);
        els.separateBtn.addEventListener('click', onSeparate);
        els.moveBtn.addEventListener('click', onMoveToggle);
        els.editRoomsBtn.addEventListener('click', toggleEditRooms);
        els.renumberBtn.addEventListener('click', function () {
            requestRenumber(els.renumberBtn);
        });
        els.resetBtn.addEventListener('click', onReset);
        els.installBtn.addEventListener('click', onInstallClick);

        els.rooms.addEventListener('click', function (event) {
            const addTable = event.target.closest('[data-add-table]');
            if (addTable) {
                addTableToRoom(addTable.dataset.addTable);
                return;
            }

            const card = event.target.closest('.entity');
            if (card) {
                const entity = { kind: card.dataset.kind, id: Number(card.dataset.id) };
                if (assigningReservationId) {
                    assignReservationToEntity(entity);
                } else if (moveMode) {
                    handleMovePick(entity);
                } else {
                    toggleSelection(entity);
                }
                return;
            }

            const gap = event.target.closest('.floor-gap');
            if (gap && moveMode) {
                handleGapClick(gap.dataset.roomId, Number(gap.dataset.col), Number(gap.dataset.row));
            }
        });

        els.rooms.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') return;

            const card = event.target.closest('.entity');
            if (card) {
                event.preventDefault();
                const entity = { kind: card.dataset.kind, id: Number(card.dataset.id) };
                if (assigningReservationId) {
                    assignReservationToEntity(entity);
                } else if (moveMode) {
                    handleMovePick(entity);
                } else {
                    toggleSelection(entity);
                }
                return;
            }

            const gap = event.target.closest('.floor-gap');
            if (gap && moveMode) {
                event.preventDefault();
                handleGapClick(gap.dataset.roomId, Number(gap.dataset.col), Number(gap.dataset.row));
            }
        });

        els.form.addEventListener('submit', onSubmit);
        els.cancelEditBtn.addEventListener('click', cancelEdit);

        els.targetInfo.addEventListener('click', function (event) {
            const step = event.target.closest('[data-seat-step]');
            if (!step || step.disabled) return;
            stepTableSeats(Number(step.dataset.tableId), Number(step.dataset.seatStep));
        });

        els.targetInfo.addEventListener('input', function (event) {
            if (event.target.classList.contains('seat-input')) showSeatError('');
        });

        els.targetInfo.addEventListener('change', function (event) {
            if (event.target.classList.contains('seat-input')) commitSeatInput(event.target);
        });

        els.targetInfo.addEventListener('keydown', function (event) {
            if (!event.target.classList.contains('seat-input')) return;
            if (event.key !== 'Enter') return;
            event.preventDefault();
            event.stopPropagation();
            commitSeatInput(event.target);
        });

        [els.guestName, els.guestPhone, els.guestCount].forEach(function (input) {
            input.addEventListener('input', function () {
                clearFieldError(input);
            });
        });

        els.guestCount.addEventListener('input', function () {
            const single = selection.length === 1 ? selection[0] : null;
            const capacity = single ? entitySeats(single) : totalCapacity();
            const value = Number(els.guestCount.value);

            if (els.guestCount.value !== '' && Number.isFinite(value) && value > capacity) {
                setFieldError(els.guestCount, capacityError(capacity, !!single));
            }
        });

        els.formDate.addEventListener('input', function () {
            clearFieldError(els.formDate);
            applyTypedSlotIfComplete();
        });

        els.formTime.addEventListener('input', function () {
            clearFieldError(els.formTime);
            applyTypedSlotIfComplete();
        });

        els.formDate.addEventListener('blur', function () {
            normalizeSlotField(els.formDate);
        });

        els.formTime.addEventListener('blur', function () {
            normalizeSlotField(els.formTime);
        });

        document.addEventListener('keydown', function (event) {
            if (event.key !== 'Escape') return;

            if (assigningReservationId) {
                assigningReservationId = null;
                renderAll();
                toast('Assegnazione annullata.', 'info');
                return;
            }

            if (moveMode) {
                if (movePicked) {
                    movePicked = null;
                    renderRooms();
                    renderSelectionUI();
                    toast('Tavolo deselezionato. Modalità spostamento ancora attiva.', 'info');
                    return;
                }
                moveMode = false;
                renderAll();
                toast('Modalità spostamento chiusa.', 'info');
                return;
            }

            if (selection.length) {
                clearSelection();
                renderRooms();
                renderSelectionUI();
                syncForm();
            }
        });
    }
})();
