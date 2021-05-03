'use strict';

import './ui.css';
import { makeXml, parseXml, StyledText } from './figma/styledText';
import { encodeUtf8 } from './util/utf8';
import ISO6391 from 'iso-639-1';

const PLUGINDATA_SRC_VARIANT = 'src'; // TODO: move to common const

const JSON_KIND_ASSETS_CHANGE = 'assetsChange';

const MAX_ACTIVITY_LOG_ROWS = 50;
const WS_RECONNECT_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
//const INITIAL_SCAN_DELAY = 30 * 1000; // 30 seconds in milliseconds
//const REGULAR_SCAN_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds

const NORMALIZED_VARIANT = {
    'es-latam': 'es-419',
    'zh-cn': 'zh-Hans',
    'zh-tw': 'zh-Hant'
};

const VARIANT_NAMES = {
    'es-419': 'Spanish (Latin America)',
    'pt-br': 'Brazilian Portuguese',
    'zh-Hans': 'Simplified Chinese',
    'zh-Hant': 'Traditional Chinese'
};

interface PluginData {
    id: string;
    type: string;
    nodeType: string;
    variantCode?: string;
    availableVariants?: Array<string>;
    variants?: Object | string;
    isAsset?: boolean;
    comments?: string;
    error?: string;
    isReady?: boolean;
    wasModified?: boolean;
}

let ws;
let selectedNode: PluginData | undefined;
let logStatusId = 0;

let isOnline: boolean = false;
let isScanning: boolean = false;

//let autoMode: boolean = false;
//let autoModeTimer;

initialize();

function initialize() {
    // initialize event listeners

    log('Plugin started');

    // tabs
    document.getElementById('tabs').onmousedown = onTabsMouseDown;
    document.getElementById('inspectorTab').onclick = switchTab;
    document.getElementById('serverTab').onclick = switchTab;
    document.getElementById('dangerZoneTab').onclick = switchTab;
    document.getElementById('debugTab').onclick = switchTab;

    // Inspector tab
    document.getElementById('gotoNodeInput').onkeydown = onGotoNodeInputKeyDown;
    document.getElementById('gotoNodeInput').oninput = onGotoNodeInputInput;
    document.getElementById('gotoNodeBtn').onclick = gotoNode;
    document.getElementById('variantSelect').onchange = onVariantSelectChange;
    document.getElementById('switchAssetVariantBtn').onclick = onSwitchAssetVariantBtnClick;
    document.getElementById('variantEditor').onkeydown = onVariantEditorKeyDown;
    document.getElementById('variantUpdateBtn').onclick = onVariantUpdateBtnClick;
    document.getElementById('updateFromSceneBtn').onclick = onUpdateFromSceneBtnClick;
    document.getElementById('assetUpdateBtn').onclick = onAssetUpdateBtnClick;

    // Server tab
    document.getElementById('connectBtn').onclick = connectToLiveUpdateServer;
    //document.getElementById('autoScanCheckbox').onclick = updateAutoScanMode;
    document.getElementById('scanBtn').onclick = onScanBtnClick;

    // Debug tab
    document.getElementById('testExportBtn').onclick = testExportCurrentVariant;
    document.getElementById('testExportAllBtn').onclick = testExportAllVariants;

    document.getElementById('addVariantBtn').onclick = addVariantBtnClick;
    document.getElementById('removeVariantBtn').onclick = removeVariantBtnClick;
    document.getElementById('removeOtherVariantsBtn').onclick = removeOtherVariantsBtnClick;

    //document.getElementById('testCustomFnBtn').onclick = testCustomFn;

    // initialize application

    connectToLiveUpdateServer();

    // try to reconnect every 5 minutes
    setInterval(connectToLiveUpdateServer, WS_RECONNECT_INTERVAL);

    // select the tab
    document.getElementById('inspectorTab').click();
    //document.getElementById('serverTab').click(); // DEBUG
    //document.getElementById('dangerZoneTab').click(); // DEBUG
    //document.getElementById('debugTab').click(); // DEBUG
}

let tabsShiftMouseClicks = 0;
function onTabsMouseDown(e) {
    if (tabsShiftMouseClicks === 3) {
        return;
    }
    if (e.shiftKey) {
        tabsShiftMouseClicks++;
        if (tabsShiftMouseClicks === 3) {
            document.body.classList.add('debug');
        }
    }
}

function switchTab() {
    const c = document.getElementById('container');
    c.classList.remove('inspectorTab', 'serverTab', 'dangerZoneTab', 'debugTab');
    c.classList.add(this.id);
}

function testExportCurrentVariant() {
    if (!selectedNode || !selectedNode.id) {
        notify('No node selected');
        return;
    }

    parent.postMessage(
        {
            pluginMessage: {
                exportCurrentAssetVariantById: true,
                id: selectedNode.id,
            },
        },
        '*'
    );
}

function testExportAllVariants() {
    if (!selectedNode || !selectedNode.id) {
        notify('No node selected');
        return;
    }

    parent.postMessage(
        {
            pluginMessage: {
                exportAssetNodeById: true,
                id: selectedNode.id,
            },
        },
        '*'
    );
}

function manageVariant(action) {
    const variant = document.getElementById('variant').value;
    const scope = document.getElementById('scope').value;

    if (scope !== 'page' && (!selectedNode || !selectedNode.id)) {
        notify('No node selected');
        return;
    }

    parent.postMessage(
        {
            pluginMessage: {
                manageVariant: true,
                action: action,
                id: selectedNode?.id,
                variant: variant,
                scope: scope
            },
        },
        '*'
    );
}

function addVariantBtnClick() {
    manageVariant('add');
}

function removeVariantBtnClick() {
    manageVariant('remove');
}

function removeOtherVariantsBtnClick() {
    manageVariant('remove_other');
}

function testCustomFn() {
    if (!selectedNode || !selectedNode.id) {
        notify('No node selected');
        return;
    }

    parent.postMessage(
        {
            pluginMessage: {
                testCustomFn: true,
                id: selectedNode.id,
            },
        },
        '*'
    );
}

function updateVariantsDropdown() {
    const el = document.getElementById('targetVariants');
    let html = '';
    if (selectedNode.availableVariants) {
        selectedNode.availableVariants.forEach((v) => {
            if (v === 'src') {
                return;
            }
            let code = NORMALIZED_VARIANT[v] || v;

            const name = VARIANT_NAMES[code] || ISO6391.getName(code);
            const nativeName = ISO6391.getNativeName(code);
            if (name !== '' && nativeName !== '') {
                html += `<option value="${v}">${v} — ${name} (${nativeName})</option>`;
            } else if (name !== '') {
                html += `<option value="${v}">${v} — ${name}</option>`;
            } else {
                html += `<option value="${v}">${v}</option>`;
            }
        });
    }
    el.innerHTML = html;
}

function getSelectedVariantCode() {
    const inp = document.getElementById('variantSelect') as HTMLSelectElement;
    return inp.value;
}

function setSelectedVariantCode(variant: string) {
    const inp = document.getElementById('variantSelect') as HTMLSelectElement;
    inp.value = variant;
}

function getSelectedVariantText() {
    const inp = document.getElementById('variantEditor') as HTMLSelectElement;
    return inp.value;
}

function onGotoNodeInputKeyDown(e) {
    //console.log('onGotoNodeInputKeyDown()', 'e:', e);
    if (e.key === 'Enter') {
        e.preventDefault();
        gotoNode();
    }
}

function onGotoNodeInputInput() {
    const inp = document.getElementById('gotoNodeInput') as HTMLInputElement;
    const val = inp.value.trim();
    console.log('onGotoNodeInputInput()', 'val:', val);
    let btnVisible = false;
    if (val !== '' && (!selectedNode || val !== selectedNode.id)) {
        btnVisible = true;
    }
    const btn = document.getElementById('gotoNodeBtn') as HTMLButtonElement;
    btn.classList.toggle('hidden', !btnVisible);
}

function gotoNode() {
    const inp = document.getElementById('gotoNodeInput') as HTMLInputElement;
    if (inp.value === '') {
        inp.focus();
        return;
    }

    parent.postMessage(
        {
            pluginMessage: {
                gotoNode: true,
                id: inp.value,
            },
        },
        '*'
    );
}

function updateNodeEditor() {
    console.log('updateNodeEditor: selectedNode:', selectedNode);
    updateAssetEditor();
    updateVariantEditor();
}

function updateAssetEditor() {
    const assetContainer = document.getElementById('assetEditorContainer') as HTMLDivElement;

    const editable = !!(selectedNode && selectedNode.isAsset);
    console.log('updateAssetEditor, editable:', editable);
    assetContainer.classList.toggle('editable', editable);
    if (!editable) {
        return;
    }

    const ta = document.getElementById('assetComments') as HTMLTextAreaElement;
    ta.value = selectedNode.comments;

    let cbx = document.getElementById('assetReady') as HTMLInputElement;
    cbx.checked = selectedNode.isReady;

    cbx = document.getElementById('assetWasModified') as HTMLInputElement;
    cbx.checked = selectedNode.wasModified;
}

function updateVariantEditor() {
    const code = getSelectedVariantCode();
    const ta = document.getElementById('variantEditor') as HTMLTextAreaElement;
    const container = document.getElementById('variantEditorContainer') as HTMLDivElement;
    const indicator = document.getElementById('variantErrorIndicator') as HTMLDivElement;

    const editable = !!(selectedNode && selectedNode.variants && selectedNode.type === 'TEXT');
    console.log('updateVariantEditor, editable:', editable);
    container.classList.toggle('editable', editable);
    indicator.classList.toggle('hidden', !selectedNode || selectedNode.error === undefined);
    indicator.setAttribute('title', selectedNode ? selectedNode.error : '');

    if (!editable) {
        return;
    }

    const v = selectedNode.variants[code];
    if (!v) {
        console.log('no variant found');
        ta.value = '';
        return;
    }

    if (v.ranges && v.ranges.length > 0) {
        ta.value = makeXml(v);
    } else {
        ta.value = v.text;
    }
}

function onSelectionChange() {
    if (selectedNode) {
        updateVariantsDropdown();
        if (selectedNode.variantCode !== undefined) {
            setSelectedVariantCode(selectedNode.variantCode);
        }
    }
    updateNodeEditor();
    onGotoNodeInputInput();
    onVariantSelectChange();
}

function onVariantSelectChange() {
    updateNodeEditor();
    const variant = getSelectedVariantCode();
    console.log('onVariantSelectChange()', 'variant:', variant);

    const inp = document.getElementById('variantSelect') as HTMLSelectElement;
    const swBtn = document.getElementById('switchAssetVariantBtn') as HTMLButtonElement;
    const upBtn = document.getElementById('updateFromSceneBtn') as HTMLButtonElement;

    let swBtnVisible = false;
    if (selectedNode && selectedNode.variantCode !== variant) {
        swBtnVisible = true;
    }

    let upBtnVisible = false;
    if (
        selectedNode &&
        selectedNode.variantCode === variant &&
        selectedNode.variantCode === PLUGINDATA_SRC_VARIANT &&
        selectedNode.type === 'TEXT'
    ) {
        upBtnVisible = true;
    }

    inp.classList.toggle('hidden', !selectedNode);
    swBtn.classList.toggle('hidden', !swBtnVisible);
    upBtn.classList.toggle('hidden', !upBtnVisible);
}

function onSwitchAssetVariantBtnClick() {
    console.log('onSwitchAssetVariantBtnClick()');
    const code = getSelectedVariantCode();
    if (!selectedNode || !selectedNode.id || code === '') {
        return;
    }

    parent.postMessage(
        {
            pluginMessage: {
                switchAssetVariant: true,
                id: selectedNode.id,
                variant: code,
            },
        },
        '*'
    );
}

function onVariantEditorKeyDown(e) {
    //console.log('onVariantEditorKeyDown()', 'e:', e);
    if (e.metaKey && e.key === 'Enter') {
        e.preventDefault();
        onVariantUpdateBtnClick();
    }
}

function onVariantUpdateBtnClick() {
    console.log('onVariantUpdateBtnClick()');
    if (!selectedNode || !selectedNode.id || !selectedNode.variants) {
        return;
    }
    const code = getSelectedVariantCode();
    let styledText: StyledText;

    const srcVariant = selectedNode.variants[PLUGINDATA_SRC_VARIANT];
    if (srcVariant && srcVariant.ranges && srcVariant.ranges.length > 0) {
        styledText = parseXml(getSelectedVariantText());
    } else {
        styledText = {
            text: getSelectedVariantText(),
        };
    }

    selectedNode.variants[code] = styledText;

    parent.postMessage(
        {
            pluginMessage: {
                updateText: true,
                id: selectedNode.id,
                variant: code,
                text: styledText,
            },
        },
        '*'
    );
}

function onAssetUpdateBtnClick() {
    console.log('onAssetUpdateBtnClick()');
    if (!selectedNode || !selectedNode.id || !selectedNode.isAsset) {
        return;
    }

    const inp = document.getElementById('assetComments') as HTMLSelectElement;
    const comments = inp.value.trim();

    let cbx = document.getElementById('assetReady') as HTMLInputElement;
    const isReady = cbx.checked;

    cbx = document.getElementById('assetWasModified') as HTMLInputElement;
    const wasModified = cbx.checked;

    console.log(
        'comments: [' + comments + '], isReady: ' + isReady + ', wasModified: ' + wasModified
    );

    parent.postMessage(
        {
            pluginMessage: {
                updateAssetSettings: true,
                id: selectedNode.id,
                comments,
                isReady,
                wasModified,
            },
        },
        '*'
    );
}

function onUpdateFromSceneBtnClick() {
    console.log('onUpdateFromSceneBtnClick()');
    if (!selectedNode || !selectedNode.id) {
        return;
    }

    parent.postMessage(
        {
            pluginMessage: {
                updateFromScene: true,
                id: selectedNode.id,
            },
        },
        '*'
    );
}

function setOnlineState(state?: boolean) {
    // if undefined is passed, the state is neither online nor offline (i.e. connecting)
    const c = document.getElementById('container');
    c.classList.toggle('connecting', state === undefined);
    c.classList.toggle('offline', state !== true);
    c.classList.toggle('online', state === true);
    isOnline = !!state;
    if (isOnline) {
        c.classList.add('wasonline');
    }

    let s = 'Connecting...';
    if (state === true) {
        s = 'Connected to live update server';
    } else if (state === false) {
        s = 'No connection to live update server';
    }
    document.getElementById('serverStatus').textContent = s;

    //(document.getElementById('autoScanCheckbox') as HTMLInputElement).disabled = !isOnline;
    //updateAutoScanMode();
    updateScanButton();
}

onmessage = (event) => {
    let message = event.data.pluginMessage;

    if (message.event === 'selectionChange') {
        const inp = document.getElementById('gotoNodeInput') as HTMLInputElement;
        inp.value = message.data ? message.data.id || '' : '';
        console.log('selectionChange; message:', message);
        selectedNode = message.data;
        onSelectionChange();
        return;
    }

    if (message.event === 'assetsChange') {
        onAssetsChange(message.data);
        return;
    }

    if (message.event === 'parsingCompleted') {
        onParsingCompleted();
        return;
    }

    if (message.event === 'scanningCompleted') {
        onScanningCompleted();
        return;
    }

    if (message.command === 'export') {
        uploadFile(message.filename, message.bytes);
        return;
    }

    if (message.command === 'log') {
        log(message.message);
        return;
    }
};

function onWebSocketMessage(data: string) {
    let msg = JSON.parse(data);
    console.log('WebSocket message received:', msg);

    if (msg.action === 'updateText') {
        parent.postMessage(
            {
                pluginMessage: {
                    updateText: true,
                    id: msg.id,
                    text: msg.text,
                },
            },
            '*'
        );
    } else if (msg.action === 'scanAssets') {
        log('Received a request to scan assets');
        scanAssets(msg.force);
    } else if (msg.action === 'startOfFileParsing') {
        parent.postMessage(
            {
                pluginMessage: {
                    startOfFileParsing: true,
                },
            },
            '*'
        );
    } else if (msg.action === 'parseFile') {
        log('Received an updated file ' + msg.path);
        parent.postMessage(
            {
                pluginMessage: {
                    parseFile: true,
                    path: msg.path,
                    data: msg.data,
                },
            },
            '*'
        );
    } else if (msg.action === 'endOfFileParsing') {
        parent.postMessage(
            {
                pluginMessage: {
                    endOfFileParsing: true,
                },
            },
            '*'
        );
    } else {
        console.error('Unsupported action:', msg.action);
    }
}

function connectToLiveUpdateServer() {
    if (ws !== undefined) {
        return;
    }

    setOnlineState(undefined);

    try {
        ws = new WebSocket('ws://localhost:12345/ws');
    } catch (e) {
        return;
    }

    ws.onopen = function () {
        log('Established connection to live update server');
        setOnlineState(true);
    };

    ws.onmessage = function (evt) {
        onWebSocketMessage(evt.data);
    };

    ws.onclose = function () {
        log('No connection to live update server');
        setOnlineState(false);
        ws = undefined;
    };
}

function formatTime(ms: number): string {
    let s = Math.floor(ms / 1000);
    let m = Math.floor(s / 60);
    s = s - m * 60;
    const a = [];
    if (m > 0) {
        a.push(m + ' minutes');
    }
    if (s > 0) {
        a.push(s + ' seconds');
    }
    return a.join(' ');
}

/*
function updateAutoScanMode() {
    autoMode = (document.getElementById('autoScanCheckbox') as HTMLInputElement).checked;
    if (!isOnline) {
        if (autoModeTimer) {
            clearTimeout(autoModeTimer);
            autoModeTimer = undefined;
        }
        return;
    }

    if (autoMode && autoModeTimer === undefined && !isScanning) {
        log('Next auto scan in ' + formatTime(INITIAL_SCAN_DELAY));
        autoModeTimer = setTimeout(scanAssets, INITIAL_SCAN_DELAY);
        return;
    }

    if (!autoMode && autoModeTimer) {
        log('Auto scanning cancelled');
        clearTimeout(autoModeTimer);
        autoModeTimer = undefined;
    }
}
*/

function onScanBtnClick() {
    scanAssets();
}

function updateScanButton() {
    const b = document.getElementById('scanBtn') as HTMLButtonElement;
    b.disabled = !isOnline || isScanning;
}

function scanAssets(force: boolean = false) {
    if (!isOnline) {
        //clearTimeout(autoModeTimer);
        //autoModeTimer = undefined;
        return;
    }

    log('Scanning document for changes...');
    isScanning = true;

    updateScanButton();
    parent.postMessage(
        {
            pluginMessage: {
                scanAssets: true,
                force,
            },
        },
        '*'
    );
}

function onAssetsChange(data: any) {
    console.log('onAssetsChange(), data:', data);
    log('The list of assets has changed');
    uploadJson('Sending the list of assets', JSON_KIND_ASSETS_CHANGE, data);
}

function wsSend(data) {
    if (ws === undefined) {
        console.error('Websocket not initialized');
        return;
    }
    ws.send(data);
    console.log('WebSocket message sent');
}

function onParsingCompleted() {
    log('File parsing completed');
    wsSend('idle');
}

function onScanningCompleted() {
    log('Scanning completed');
    isScanning = false;
    updateScanButton();
    wsSend('idle');
}

function notify(message: string) {
    parent.postMessage(
        {
            pluginMessage: {
                notify: true,
                message,
            },
        },
        '*'
    );
}

function uploadFile(filename: string, bytes: any) {
    if (ws === undefined) {
        notify('Not connected to the server');
        return;
    }

    const statusId = log(
        'Uploading file ' + filename + ' (' + bytes.length + ' bytes)',
        false,
        true
    );

    var formData = new FormData();
    formData.append('filename', filename);
    var blob = new Blob([bytes] /*, { type: 'image/png' }*/);
    formData.append('file', blob);

    let xhr = new XMLHttpRequest();
    xhr.onloadend = () => {
        var status = xhr.status;
        console.log('xhr.onloadend', 'status:', status);
        if (status === 200) {
            //notify('Exported ' + filename + ' (' + bytes.length + ' bytes)');
            logStatus(statusId, 'ok', 'OK');
        } else {
            //notify('Upload failed');
            logStatus(statusId, 'error', 'Failed');
        }
    };
    xhr.open('POST', 'http://localhost:12345/upload');
    xhr.send(formData);
}

function uploadJson(message: string, kind: string, data: any) {
    if (ws === undefined) {
        notify('Not connected to the server');
        return;
    }

    const bytes = encodeUtf8(JSON.stringify(data));
    console.log('uploadJson, bytes:', bytes);

    const statusId = log(message + ' (' + bytes.length + ' bytes)', false, true);

    var formData = new FormData();
    formData.append('kind', kind);
    var blob = new Blob([bytes], { type: 'application/json' });
    formData.append('file', blob);

    let xhr = new XMLHttpRequest();
    xhr.onloadend = () => {
        var status = xhr.status;
        console.log('xhr.onloadend', 'status:', status);
        if (status === 200) {
            logStatus(statusId, 'ok', 'OK');
        } else {
            logStatus(statusId, 'error', 'Failed');
        }
    };
    xhr.open('POST', 'http://localhost:12345/process');
    xhr.send(formData);
}

function log(
    message: string,
    asHtml: boolean = false,
    needStatus: boolean = false
): string | undefined {
    const ts = new Date().toLocaleTimeString();
    console.log('%c ' + ts + ' ', 'background: #333; color: #cfc; border-radius: 3px;', message);

    const al = document.getElementById('activityLog');
    const atBottom = al.offsetHeight + al.scrollTop === al.scrollHeight;

    while (al.children && al.children.length > MAX_ACTIVITY_LOG_ROWS) {
        al.removeChild(al.children[0]);
    }

    const paraEl = document.createElement('p');
    const timeEl = document.createElement('time');
    const textEl = document.createElement('span');
    timeEl.innerText = ts;
    asHtml ? (textEl.innerHTML = message) : (textEl.innerText = message);
    paraEl.appendChild(timeEl);
    paraEl.appendChild(textEl);
    al.appendChild(paraEl);

    if (atBottom) {
        setTimeout(() => {
            al.scrollTop = al.scrollHeight - al.offsetHeight;
        }, 0);
    }

    if (needStatus) {
        const statusEl = document.createElement('span');
        statusEl.id = 'st' + logStatusId++;
        statusEl.className = 'status';
        paraEl.appendChild(statusEl);
        return statusEl.id;
    }
}

function logStatus(id: string, className: string, message: string, asHtml: boolean = false) {
    console.log('%c status ', 'background: #333; color: #cfc; border-radius: 3px;', message);

    const statusEl = document.getElementById(id) as HTMLSpanElement | undefined;
    if (!statusEl) {
        console.log('status element with id ' + id + ' is no longer in the log');
        return;
    }

    asHtml ? (statusEl.innerHTML = message) : (statusEl.innerText = message);
    statusEl.classList.add(className);
}
