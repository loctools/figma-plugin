'use strict';

import {
    StyledText,
    getStyledText,
    makeXml,
    parseXml,
    applyTextStyles,
    preloadFonts,
} from './figma/styledText';

import { gotoNode } from './figma/util';
import { notify } from './figma/notify';
import { hashObj, hashStr } from './util/objtree';
import { sleep } from './util/timer';
import { crc32arr } from './util/crc32';

import prof from './util/profiler';

import {
    TEMP_PAGE_NAME,
    isAssetNode,
    gatherTextNodesCallback,
    gatherAssetNodesCallback,
} from './figma/gatherTextNodes';
import { encodeUtf8 } from './util/utf8';
import { wrap } from './util/wordwrap';

const PLUGINDATA_SRC_VARIANT = 'src'; // TODO: move to common const
const PLUGINDATA_UNKNOWN_VARIANT = '';
const PLUGINDATA_STYLES = 'styles';
const PLUGINDATA_VARIANTS = 'variants';
const PLUGINDATA_VARIANT_CODE = 'variant_code';
const PLUGINDATA_COMMENTS = 'comments';
const PLUGINDATA_IS_READY = 'is_ready';
const PLUGINDATA_WAS_MODIFIED = 'was_modified';
const PLUGINDATA_ID = 'id';
const ELLIPSIS = '…';
const PREVIEW_FILE_EXT = '.png';

const CLIENTSTORAGE_ASSETS_FINGERPRINT = 'assets_fingerprint';
const CLIENTSTORAGE_ASSET_FINGERPRINT_PREFIX = 'asset_fingerprint:';

const MANAGE_VARIANT_ACTION_ADD = 'add';
const MANAGE_VARIANT_ACTION_REMOVE = 'remove';
const MANAGE_VARIANT_ACTION_REMOVE_OTHER = 'remove_other';

const MANAGE_VARIANT_SCOPE_NODE = 'node';
const MANAGE_VARIANT_SCOPE_ASSET = 'asset';
const MANAGE_VARIANT_SCOPE_PAGE = 'page';

const LOCJSON_LINE_LENGTH = 50; // as per LocJSON specs
const LOCJSON_INDENT_LENGTH = 4; // as per LocJSON specs

var filesToParse = [];

console.log('Loctools plugin started.');

figma.showUI(__html__, {
    width: 320,
    height: 400,
});

function log(message: string) {
    figma.ui.postMessage({
        command: 'log',
        message,
    });
}

function exportFile(filename: string, bytes: Uint8Array) {
    figma.ui.postMessage({
        command: 'export',
        filename,
        bytes,
    });
}

function pathFromName(s: string) {
    s = s.trim().toLowerCase().normalize('NFKD');
    s = s.replace(/['"`]/gs, '');
    s = s.replace(/[^\w\d\-\.\/]/gs, '-');
    s = s.replace(/\.+\//gs, '/');
    s = s.replace(/\/{2,}/gs, '/');
    s = s.replace(/-{2,}/gs, '-');
    return s;
}

function getPageNode(node: SceneNode | PageNode): PageNode {
    while (node.type !== 'PAGE') {
        node = node.parent as SceneNode;
    }
    //console.log('getPageNode()', 'return node:', node);
    return node as PageNode;
}

function getAssetPath(node: SceneNode, pageName?: string): string[] {
    //console.log('getAssetPath()', 'node:', node);
    return [
        pathFromName(figma.root.name),
        pathFromName(pageName || getPageNode(node).name),
        pathFromName(node.name),
    ];
}

async function onSelectionChange() {
    let data, variants;
    // Only pass selection info if a single node is selected;
    // treat multiple selection as if nothing was selected.
    if (figma.currentPage.selection.length === 1) {
        const node = figma.currentPage.selection[0];

        data = {
            id: node.id,
            type: node.type,
        };

        if (node.type === 'TEXT') {
            updateTextNodeSourceVariantIfMissing(node as TextNode);
            variants = JSON.parse(node.getPluginData(PLUGINDATA_VARIANTS) || 'null') || undefined;

            data.variantCode = getParentAssetVariantCode(node);
            if (variants) {
                data.variants = variants;
                data.availableVariants = Object.keys(variants).sort();
            } else {
                console.warn("Node's variants are not defined");
            }

            if (data.variantCode === PLUGINDATA_SRC_VARIANT) {
                // Try to preload all fonts for the saved node styles
                // to report issues, if any
                const text: StyledText = { text: '' };
                text.styles =
                    JSON.parse(node.getPluginData(PLUGINDATA_STYLES) || null) || undefined;
                if (text.styles !== undefined) {
                    try {
                        await preloadFonts(node, text);
                    } catch (e) {
                        data.error = e;
                    }
                }
            }
        }

        if (isAssetNode(node)) {
            data.variantCode = getVariantCode(node);
            data.isAsset = true;
            data.path = getAssetPath(node).join('/');
            data.comments = node.getPluginData(PLUGINDATA_COMMENTS);
            data.isReady = node.getPluginData(PLUGINDATA_IS_READY) == '1';
            data.wasModified = node.getPluginData(PLUGINDATA_WAS_MODIFIED) == '1';
            data.availableVariants = gatherVariantsForAssetNode(node);
        }
    }

    figma.ui.postMessage({
        event: 'selectionChange',
        data,
    });
}

figma.on('selectionchange', onSelectionChange);
figma.on('currentpagechange', onSelectionChange);

onSelectionChange();

figma.ui.onmessage = (message) => {
    if (message.notify) {
        // notify() called from the UI
        notify(message.message);
    } else if (message.exportCurrentAssetVariantById) {
        // Debug > [Export current variant] button
        exportCurrentAssetVariantById(message.id);
    } else if (message.exportAssetNodeById) {
        // Debug > [Export all variants] button
        exportAssetNodeById(message.id);
    } else if (message.testCustomFn) {
        // Debug > [Test custom function] button
        testCustomFn(message.id);
    } else if (message.manageVariant) {
        // Danger Zone > [Add variant], [Remove variant], [Remove other variants] buttons
        manageVariant(message.id, message.scope, message.action, message.variant);
    } else if (message.updateText) {
        // Inspector > [Save variant] button
        updateVariantById(message.id, message.variant || PLUGINDATA_SRC_VARIANT, message.text);
    } else if (message.updateAssetSettings) {
        // Inspector > [Save settings] button
        updateAssetSettingsById(message.id, message.comments, message.isReady, message.wasModified);
    } else if (message.startOfFileParsing) {
        filesToParse = [];
    } else if (message.parseFile) {
        // Server pushed an updated LocJSON file
        filesToParse.push(message);
    } else if (message.endOfFileParsing) {
        parsePendingLocJsonFiles();
    } else if (message.updateFromScene) {
        // Inspector > [Update from scene] link
        updateTextNodeSourceVariantFromScene(message.id);
    } else if (message.switchAssetVariant) {
        // Inspector > [Switch asset to XXXXXXX] link
        switchAssetVariant(message.id, message.variant);
    } else if (message.scanAssets) {
        // Server > [Scan now] button (or auto-triggered event)
        scanAssets(message.force);
    } else if (message.gotoNode) {
        // Inspector > ID input > [Go to node] button
        gotoNode(message.id);
    } else {
        console.warn('Unsupported message:', message);
    }
};

function updateTextNodeSourceVariantFromScene(id: string) {
    let node = figma.getNodeById(id) as TextNode | null;
    if (!node || node.type !== 'TEXT') {
        console.warn('updateTextNodeSourceVariantFromScene(): not a text node');
        return;
    }

    if (figma.currentPage.selection.length !== 1) {
        console.warn('updateTextNodeSourceVariantFromScene(): not a single-object selection');
        return;
    }

    if (node !== figma.currentPage.selection[0]) {
        console.warn('updateTextNodeSourceVariantFromScene(): target node not selected');
        return;
    }

    const variantCode = getParentAssetVariantCode(node);
    if (variantCode !== PLUGINDATA_SRC_VARIANT) {
        console.warn('updateTextNodeSourceVariantFromScene(): not a source variant');
        // Not a source variant; won't update anything.
        return;
    }

    updateTextNodeSourceVariant(node);
    onSelectionChange(); // force update the UI
}

function updateTextNodeSourceVariantIfMissing(node: TextNode) {
    const variants = getVariantsObject(node);
    if (variants[PLUGINDATA_SRC_VARIANT]) {
        // Variant already exists; nothing to do.
        return;
    }

    const variantCode = getParentAssetVariantCode(node);
    if (variantCode !== PLUGINDATA_SRC_VARIANT) {
        // Not a source variant; won't update anything.
        return;
    }

    updateTextNodeSourceVariant(node);
}

/**
 * updateTextNodeSourceVariant() unconditionally
 * gets styled text from node.characters
 * and sets it as source variant + styles;
 * it doesn't check if the current text represents source.
 * @param node
 */
function updateTextNodeSourceVariant(node: TextNode) {
    console.log('updateTextNodeSourceVariant()');

    // If this is a plain text, styledText will only have
    // the `text` member set. Otherwise, it will also contain
    // ranges and a list of styles.
    const styledText = getStyledText(node);

    if (styledText.styles) {
        // If there are styles, save the parsed styles a global ones.
        node.setPluginData(PLUGINDATA_STYLES, JSON.stringify(styledText.styles));

        // Now, delete styles from the styled text,
        // regardless of the variant code, since we don't
        // need to keep them inside variants (we already
        // have them defined globally).
        delete styledText.styles;
    } else {
        // Otherwise, remove styles.
        node.setPluginData(PLUGINDATA_STYLES, '');
    }

    // Set the text (plus ranges, if set) as a variant.
    setVariantText(node, PLUGINDATA_SRC_VARIANT, styledText);
}

function getAssetNode(childNode: SceneNode): SceneNode | undefined {
    let node = childNode;
    while (node && !isAssetNode(node)) {
        if (!node.parent) {
            break;
        }
        node = node.parent as SceneNode;
    }

    if (!isAssetNode(node)) {
        return;
    }
    return node;
}

function getVariantCode(node: SceneNode): string {
    return node.getPluginData(PLUGINDATA_VARIANT_CODE) || PLUGINDATA_SRC_VARIANT;
}

function getParentAssetVariantCode(node: SceneNode): string {
    const assetNode = getAssetNode(node);
    if (!assetNode) {
        return PLUGINDATA_SRC_VARIANT;
    }
    return getVariantCode(assetNode);
}

function setVariantCode(node: SceneNode, variant: string) {
    node.setPluginData(PLUGINDATA_VARIANT_CODE, variant);
}

function getVariantsObject(node: SceneNode): Object {
    return JSON.parse(node.getPluginData(PLUGINDATA_VARIANTS) || '{}');
}

function getVariantText(node: SceneNode, variant: string): StyledText | undefined {
    const variants = getVariantsObject(node);
    return variants[variant] || undefined;
}

interface RenderedText {
    text: string;
    isXml: boolean;
}

function renderVariantText(node: TextNode, variant: string): RenderedText {
    let text: string;
    let isXml = false;
    const v = getVariantText(node, variant);
    if (v !== undefined) {
        if (v.ranges && v.ranges.length > 0) {
            text = makeXml(v);
            isXml = true;
        } else {
            text = v.text;
        }
    } else {
        text = node.characters;
    }

    return {
        text,
        isXml,
    };
}

function setVariantText(node: SceneNode, variant: string, text: StyledText) {
    const variants = getVariantsObject(node);
    if (text.text !== undefined && text.text !== '') {
        variants[variant] = text;
    } else {
        delete variants[variant];
    }
    node.setPluginData(PLUGINDATA_VARIANTS, JSON.stringify(variants));
}

async function updateVariantById(id: string, variant: string, text: StyledText | string) {
    type t = BaseNodeMixin & TextNode;
    let node: t = gotoNode(id) as t;
    if (!node || node.type !== 'TEXT') {
        return;
    }

    await updateVariant(node, variant, text);
}

async function updateVariant(node: TextNode, variant: string, text: StyledText | string) {
    console.log('updateVariant()', 'id:', node.id, 'variant:', variant, 'text:', text);

    // Convert plain string (xml) to a StyledText object.
    if (typeof text === 'string') {
        console.warn('DEBUG mode only: updateVariant() got text as raw XML string');
        let parsed: StyledText;
        try {
            parsed = parseXml(text);
        } catch (e) {
            console.warn('updateVariant() failed for node ' + node.id + ' text: ' + text);
            console.warn(e);
            return;
        }
        text = parsed;
    }

    setVariantText(node, variant, text);

    const assetNode = getAssetNode(node);
    if (!assetNode) {
        console.log('asset node not found');
        return;
    }
    console.log('found asset node:', assetNode.id);

    if (variant !== getVariantCode(assetNode)) {
        //console.log("Asset variant is different; won't update the node yet");
        return;
    }

    await refreshTextNodeContent(node, variant);
}

async function updateAssetSettingsById(
    id: string,
    comments: string,
    isReady: boolean,
    wasModified: boolean
) {
    console.log('updateAssetSettingsById()', 'id:', id);

    let node = figma.getNodeById(id) as SceneNode | null;
    if (!node) {
        return;
    }

    node.setPluginData(PLUGINDATA_COMMENTS, comments);
    node.setPluginData(PLUGINDATA_IS_READY, isReady ? '1' : '');
    node.setPluginData(PLUGINDATA_WAS_MODIFIED, wasModified ? '1' : '');
}

async function switchAssetVariant(id: string, variant: string) {
    console.log('switchAssetVariant()', 'child id:', id, 'variant:', variant);

    let node = figma.getNodeById(id) as SceneNode | null;
    if (!node) {
        return;
    }

    const assetNode = getAssetNode(node);
    if (!assetNode) {
        console.log('asset node not found');
        return;
    }
    console.log('found asset node:', assetNode.id);

    const currentVariant = getVariantCode(assetNode);
    if (variant === currentVariant) {
        console.log('asset node already set to the target variant');
        return;
    }

    if (currentVariant === PLUGINDATA_SRC_VARIANT) {
        updateAllMissingTextNodeSourceVariants(assetNode);
    }

    // Set a temporary variant value to indicate we're in the middle
    // of updates (since refreshing nodes is done asynchronously)
    setVariantCode(assetNode, PLUGINDATA_UNKNOWN_VARIANT);

    // Go through the entire tree and update text nodes
    // to the new variant.
    await refreshAllTextNodes(assetNode, variant);

    // Set the final variant once all nodes are processed.
    setVariantCode(assetNode, variant);

    // If the currently selected node belongs to the same asset node,
    // fire the selection event again to force update the UI.
    if (figma.currentPage.selection.length === 1) {
        const selAssetNode = getAssetNode(figma.currentPage.selection[0]);
        if (selAssetNode === assetNode) {
            onSelectionChange();
        }
    }
}

async function refreshAllTextNodes(assetNode: SceneNode, variant: string) {
    const promises = [];
    prof.reset();

    gatherTextNodesCallback(assetNode, (node: TextNode) => {
        // Run all refreshTextNodeContent() concurrently
        // and gather their promises into the array.
        promises.push(refreshTextNodeContent(node, variant));
    });
    // Wait for all promises to be resolved.
    await Promise.all(promises);

    prof.report();

    console.log('refreshAllTextNodes() finished');
}

async function refreshTextNodeContent(node: BaseNodeMixin & TextNode, variant: string) {
    //console.log('refreshTextNodeContent()', 'node.id:', node.id);
    let text = getVariantText(node, variant);
    console.log(
        'refreshTextNodeContent()',
        'node.id:',
        node.id,
        'variant:',
        variant,
        'text:',
        text
    );
    // if no variant set, try to fall back to src variant
    if (text === undefined && variant !== PLUGINDATA_SRC_VARIANT) {
        text = getVariantText(node, PLUGINDATA_SRC_VARIANT);
        console.log('using src variant text:', text);
    }

    if (text === undefined) {
        console.error('Failed to get variant data for node ' + node.id);
        return;
    }

    if (text.styles === undefined && text.ranges !== undefined) {
        text.styles = JSON.parse(node.getPluginData(PLUGINDATA_STYLES) || null) || undefined;
        if (text.styles === undefined) {
            console.warn('refreshTextNodeContent() got empty styles with non-empty ranges');
        }
    }

    //console.log(':1');
    //console.log('Preloading fonts for node ' + node.id);

    let timer1 = prof.start('font preloading');
    //let timer2 = prof.start('preload fonts for node #' + node.id);

    // Preload all fonts for the node (with the saved styles)
    try {
        await preloadFonts(node, text);
    } catch (e) {
        console.error(e);
        console.error('Failed to preload fonts for node ' + node.id);
        console.error('text object:', text);
    }

    prof.stopAndAppend(timer1);
    //prof.stopAndReport(timer2);

    //console.log(':2');

    // Set initial text.
    try {
        // Ignore the trailing whitespace, since
        // it is invisible, anyway
        node.characters = text.text.trimEnd();
    } catch (e) {
        console.error(e);
        console.error('Failed to set characters for node ' + node.id);
        console.error('text object:', text);
        return;
    }
    if (text.ranges !== undefined && text.styles !== undefined) {
        let timer2 = prof.start('style applying');
        try {
            await applyTextStyles(node, text);
        } catch (e) {
            console.error(e);
            const origId = node.getPluginData(PLUGINDATA_ID) || 'unknown';
            console.error(
                'Failed to apply text styles for node ' + node.id + ' (original ID: ' + origId + ')'
            );

            console.error('text object:', text);
        }
        prof.stopAndAppend(timer2);
    }

    //console.log(':3');

    const frame = node.parent as FrameNode;

    // Fit text to frame.

    // Check if:
    // - parent exists and is a frame, group or component
    // - parent has a single child (our text node)
    // - text node is at coordinates [0, 0] within the frame
    //   (subject to rounding to the nearest pixel)
    // - text node is autoresizable
    if (
        (frame.type !== 'FRAME' && frame.type !== 'GROUP' && frame.type !== 'COMPONENT') ||
        Math.round(node.x) !== 0 ||
        Math.round(node.y) !== 0 ||
        frame.children.length !== 1 ||
        node.textAutoResize === 'NONE'
    ) {
        /** /
        console.log(
            'Node ' + node.id + ' is not resizable; ',
            'frame.type:',
            frame.type,
            'frame.children.length:',
            frame.children.length,
            'node.x:',
            node.x,
            'node.y:',
            node.y,
            'node.textAutoResize:',
            node.textAutoResize
        );
        /**/
        return;
    }

    function textNodeFits(): boolean {
        // This function assumes text is at coordinates [0, 0].

        // 'Auto Width' mode in Figma UI
        if (node.textAutoResize === 'WIDTH_AND_HEIGHT') {
            // Only check if text fits the width.
            // Rounding is used since Figma sometimes uses
            // fractional widths that can slightly mismatch between the
            // text object and frame that encloses it.
            return Math.round(frame.width) >= Math.round(node.width);
        }

        // 'Auto Height' button in Figma UI
        if (node.textAutoResize === 'HEIGHT') {
            // Check if text fits both width and height,
            // subject to rounding (see the explanation above).
            return (
                Math.round(frame.width) >= Math.round(node.width) &&
                Math.round(frame.height) >= Math.round(node.height)
            );
        }
    }

    //console.log(':4');

    if (textNodeFits()) {
        //console.log('Node ' + node.id + ' fully fits the frame');
        return;
    }

    /*
    // test: for the specific frame, try adjusting
    // font size rather than trim the text
    if (frame.id === '7:458') {
        // gather ranges
        const origText = clone(text) as StyledText;
        if (!origText.styles) {
            origText.styles = [
                {
                    fontSize: node.getRangeFontSize(0, 1),
                },
            ];

            origText.ranges = [
                {
                    start: 0,
                    end: node.characters.length,
                    styleIdx: 0,
                },
            ];
        }

        function clone(val) {
            return JSON.parse(JSON.stringify(val));
        }

        async function setScaled(val) {
            console.log('setScaled', 'val:', val);
            const scaledText = clone(origText) as StyledText;
            for (let i = 0; i < scaledText.styles.length; i++) {
                const s = scaledText.styles[i];
                if (!s['fontSize']) {
                    continue;
                }
                s['fontSize'] = s['fontSize'] * val;
            }

            console.log('scaledText:', scaledText);
            await applyTextStyles(node, scaledText);
        }

        let start = 0.5;
        let mid;
        let end = 1;
        let lastFit = 1;

        while (end - start > 0.05) {
            mid = (start + end) / 2;
            console.log('[fit iteration] start:', start, 'mid:', mid, 'end:', end);

            await setScaled(mid);

            if (!textNodeFits()) {
                console.log("text doesn't fit");
                end = mid;
            } else {
                console.log('text fits');
                lastFit = start = mid;
            }
        }
        console.log('[fit ended] start:', start, 'end:', end);

        // if we ended iterating on a text that won't fit,
        // go back to the last successfully fitted text
        if (!textNodeFits()) {
            await setScaled(lastFit);
        }

        return;
    }
    */

    timer1 = prof.start('text fitting');
    //timer2 = prof.start('fit text for node #' + node.id);

    // Instead of doing `node.characters = s`, which resets styles,
    // try to find the longest common string prefix, keep it, and append
    // just the part that differs with the style of the last common
    // character.
    function adjustCharacters(s) {
        const old = node.characters;
        const min = old.length < s.length ? old.length : s.length;
        let i = 0;
        while (i < min) {
            if (old[i] !== s[i]) {
                break;
            }
            i++;
        }
        //console.log('adjustCharacters()', 'old: [' + old + '] s: [' + s + '] common part: [' + s.substring(0, i) + ']');
        node.deleteCharacters(i, old.length);
        if (s.length > i) {
            node.insertCharacters(i, s.substring(i, s.length), 'AFTER');
        }
    }

    async function setTrimmed(trimmed, text) {
        //console.log('setTrimmed', 'trimmed:', trimmed, 'text:', text);
        adjustCharacters(trimmed + ELLIPSIS);
        //node.characters = trimmed + ELLIPSIS;
        //console.log('trying [' + node.characters + ']');
        if (text.ranges !== undefined) {
            let timer = prof.start('style applying');
            await applyTextStyles(node, text);
            prof.stopAndAppend(timer);
        }
    }

    // Check if the text node fits within the parent frame,
    // and if it doesn't, try a divide-and-conquer method of
    // splitting the string into half and seeing if
    // trimmed part+ellipsis would fit.
    // At the very minimum, the text will show just the ellipsis.
    let start = 0;
    let mid;
    let end = text.text.length;
    let trimmed = '';
    let lastFit = 0;

    while (end - start > 1) {
        mid = Math.floor((start + end) / 2);
        //console.log('[fit iteration] start:', start, 'mid:', mid, 'end:', end);

        trimmed = text.text.substring(0, mid);
        try {
            await setTrimmed(trimmed, text);
        } catch (e) {
            console.error(e);
            const origId = node.getPluginData(PLUGINDATA_ID) || 'unknown';
            console.error(
                'Failed to set trimmed text for node ' + node.id + ' (original ID: ' + origId + ')'
            );
            console.error('text object:', text);
            break; // do not try to fit the text further
        }

        if (!textNodeFits()) {
            //console.log("text doesn't fit");
            end = mid;
        } else {
            //console.log('text fits');
            lastFit = start = mid;
        }
    }
    //console.log('[fit ended] start:', start, 'end:', end);

    // if we ended iterating on a text that won't fit,
    // go back to the last successfully fitted text
    if (!textNodeFits()) {
        await setTrimmed(text.text.substring(0, lastFit), text);
    }

    prof.stopAndAppend(timer1);
    //prof.stopAndReport(timer2);

    //console.log('Trimmed text to: ', node.characters);

    //console.log(':5');

    // Auto-lock trimmed text nodes.
    // Update: Seems like locking text nodes doesn't allow to select
    // them by double-clicking to click through parents, so this makes
    // the whole experience worse.
    //node.locked = true;

    //console.log(':6');
}

/**
 * guessOrigIdForNode() returns a guessed original node ID
 * for a given scene node, provided the node is a cloned
 * component node.
 * @param node scene node to get original ID for.
 */
function guessOrigIdForNode(node: SceneNode): string {
    // It seems like cloned component nodes don't get plugin data
    // copied over. However, their IDs are constructed in such a way
    // that allows one to determine the original ID. For example,
    // if node has an ID like `Iaaa:bbb;ccc:ddd;eee:fff`
    // then it was created from a component with ID `Iccc:ddd;eee:fff`.
    // if the ID was `Iccc:ddd;eee:fff`, then the original component
    // is assumed to be `eee:fff` (without 'I'), since it's the only
    // part of the ID path.
    // This allows to calculate that original ID, and use it to get
    // the original node plugin data.
    if (node.id.startsWith('I')) {
        const parentIds = node.id.substr(1).split(';').slice(1);
        let assumedId = parentIds.join(';');
        if (parentIds.length > 1) {
            assumedId = 'I' + assumedId;
        }
        console.warn('Assuming ID ' + assumedId + ' for node ' + node.id);
        return assumedId;
    } else {
        console.error('No original ID can be guessed for node ' + node.id);
        return '';
    }
}

/**
 * exportImagesForAssetNode() accepts the asset node,
 * goes through its export settings, renders all the images
 * and sends them over to the server. It uses the current
 * variant and current state of text nodes and doesn't
 * change the data.
 * @param assetNode asset node to export images for.
 */
async function exportImagesForAssetNode(assetNode: SceneNode, pageName?: string) {
    const f = assetNode as FrameNode;
    const variant = getVariantCode(assetNode);
    const filePath = getAssetPath(assetNode, pageName);
    filePath.push(variant);

    let previewBytes: Uint8Array;
    let esPreview: ExportSettings;
    let dropShadows = [];

    for (let i in assetNode.exportSettings) {
        const es = assetNode.exportSettings[i];
        const bytes = await assetNode.exportAsync(es);
        const filename = 'assets/' + filePath.join('/') + es.suffix + '.' + es.format.toLowerCase();

        for (let i = 0; i < f.effects.length; i++) {
            const effect = f.effects[i];
            if (effect.type === 'DROP_SHADOW' && effect.visible) {
                dropShadows.push(i);
            }
        }

        if (
            !previewBytes &&
            es.format === 'PNG' &&
            es.contentsOnly &&
            f.clipsContent &&
            dropShadows.length === 0
        ) {
            console.log('Will reuse a preview-compatible asset');
            previewBytes = bytes;
            esPreview = es;
        }

        exportFile(filename, bytes);
    }

    if (!previewBytes) {
        console.log('No preview-compatible asset was generated; will generate one');
        // use first export settings in the list to get the scale value
        // for the preview image
        const es = assetNode.exportSettings[0] as ExportSettingsImage;
        let scale = 1;
        if (es && es.constraint && es.constraint.type === 'SCALE') {
            scale = es.constraint.value;
        }
        esPreview = {
            format: 'PNG',
            constraint: {
                type: 'SCALE',
                value: scale,
            },
        };
        const f = assetNode as FrameNode;
        let clippingWasSet = false;
        if (!f.clipsContent) {
            f.clipsContent = true;
            clippingWasSet = true;
        }

        function clone(val) {
            return JSON.parse(JSON.stringify(val));
        }

        let clonedEffects;
        if (dropShadows.length > 0) {
            clonedEffects = clone(f.effects);
            dropShadows.forEach((i) => (clonedEffects[i].visible = false));
            f.effects = clonedEffects;
        }

        previewBytes = await assetNode.exportAsync(esPreview);
        if (clippingWasSet) {
            f.clipsContent = false;
        }

        if (dropShadows.length > 0) {
            dropShadows.forEach((i) => (clonedEffects[i].visible = true));
            f.effects = clonedEffects;
        }
    }

    const previewFilenameBase = 'preview/' + filePath.join('/');

    exportFile(previewFilenameBase + PREVIEW_FILE_EXT, previewBytes);

    // prepare the preview JSON data

    const nodes = {};
    const assetX = assetNode.absoluteTransform[0][2];
    const assetY = assetNode.absoluteTransform[1][2];
    gatherTextNodesCallback(assetNode, (node: TextNode) => {
        const origId = node.getPluginData(PLUGINDATA_ID);
        if (origId === '') {
            console.error('No original ID found for node ' + node.id);
            return;
        }
        nodes[origId] = [
            Math.round(node.absoluteTransform[0][2] - assetX),
            Math.round(node.absoluteTransform[1][2] - assetY),
            Math.round(node.width),
            Math.round(node.height),
        ];
    });

    exportFile(
        previewFilenameBase + '.json',
        encodeUtf8(JSON.stringify(nodes, Object.keys(nodes).sort(), 2))
    );
}

/**
 * exportCurrentAssetVariantById() finds an asset node
 * and calls exportImagesForAssetNode() for it.
 * @param id ID of the asset node itself of any child node
 * belonging to an exportable asset
 */
async function exportCurrentAssetVariantById(id: string) {
    let node = figma.getNodeById(id) as SceneNode;
    if (!node) {
        notify('Node ' + id + ' not found');
        return;
    }

    node = getAssetNode(node);
    if (!node) {
        notify("Selected node doesn't belong to an exportable asset");
        return;
    }

    await exportImagesForAssetNode(node);
}

async function exportAssetNodeById(id: string) {
    let node = figma.getNodeById(id) as SceneNode;
    if (!node) {
        notify('Node ' + id + ' not found');
        return;
    }

    node = getAssetNode(node);
    if (!node) {
        notify("Selected node doesn't belong to an exportable asset");
        return;
    }

    await exportAssetNode(node);
}

/**
 * updateAssetNodeSourceIds() goes through the asset node tree
 * and ensures that every text node has its ID saved in
 * pluginData as well (since the original ID is needed when the
 * asset is cloned for exporting).
 * @param assetNode asset node to process.
 */
function updateAssetNodeSourceIds(assetNode: SceneNode) {
    console.log('updateAssetNodeSourceIds()');
    gatherTextNodesCallback(assetNode, (node: TextNode) => {
        const origId = node.getPluginData(PLUGINDATA_ID);
        // Note that here origId can me either empty (missing),
        // which is a most common case, or it can be different
        // from a real ID (this can happen if one makes a copy
        // of an object in Figma). In both cases we want to
        // reset the ID to the actual object ID.
        if (origId !== node.id) {
            console.log('Saving original node ID for node ' + node.id);
            node.setPluginData(PLUGINDATA_ID, node.id);
        }
    });
}

/**
 * updateAllMissingTextNodeSourceVariants() goes through the asset node tree
 * and ensures that every text node has a source variant set.
 * This is needed to be able to switch back to source variant
 * from the plugin UI.
 * @param assetNode asset node to process.
 */
function updateAllMissingTextNodeSourceVariants(assetNode: SceneNode) {
    console.log('updateAllMissingTextNodeSourceVariants()');
    if (getVariantCode(assetNode) !== PLUGINDATA_SRC_VARIANT) {
        console.warn('assetNode variant is not PLUGINDATA_SRC_VARIANT; will skip');
        return;
    }

    gatherTextNodesCallback(assetNode, (node: TextNode) => {
        updateTextNodeSourceVariantIfMissing(node);
    });
}

/**
 * updateMissingPluginDataForClonedComponents() goes through the asset
 * node tree and ensures that every text node that has no original ID saved,
 * it gets pluginData from the assumed original ID of the component
 * @param assetNode asset node to process.
 */
function updateMissingPluginDataForClonedComponents(assetNode: SceneNode) {
    console.log('updateMissingPluginDataForClonedComponents()');
    gatherTextNodesCallback(assetNode, (node: TextNode) => {
        let origId = node.getPluginData(PLUGINDATA_ID);
        if (origId === '') {
            origId = guessOrigIdForNode(node);
            if (origId === '') {
                console.error('Failed to guess the original ID for node ' + node.id);
                return;
            }
            console.log('Copying plugin data for node ' + node.id + ' from ' + origId);

            let origNode = figma.getNodeById(origId) as TextNode;
            if (!origNode) {
                console.error('Node ' + origId + ' not found');
                return;
            }

            [
                PLUGINDATA_SRC_VARIANT,
                PLUGINDATA_STYLES,
                PLUGINDATA_VARIANTS,
                PLUGINDATA_VARIANT_CODE,
                PLUGINDATA_COMMENTS,
                PLUGINDATA_IS_READY,
                PLUGINDATA_WAS_MODIFIED,
                PLUGINDATA_ID,
            ].forEach((x) => node.setPluginData(x, origNode.getPluginData(x)));
        }
    });
}

/**
 * exportAssetNode() creates a temporary page
 * with a clone of the provided asset node,
 * iterates through all its variants and exports
 * asset data for all variants or a specified one.
 * @param assetNode asset node to export images for.
 * @param variant exact variant to export (or all if not specified)
 */
async function exportAssetNode(assetNode: SceneNode, variant?: string) {
    if (!isAssetNode(assetNode)) {
        console.error('Node ' + assetNode.id + ' is not an asset node');
        return;
    }

    if (assetNode.getPluginData(PLUGINDATA_IS_READY) !== '1') {
        console.log('Node ' + assetNode.id + ' is not marked as ready for translation, skipping');
        return;
    }

    updateAssetNodeSourceIds(assetNode);
    updateAllMissingTextNodeSourceVariants(assetNode);

    const page = getPageNode(assetNode);
    const tmpPage = figma.createPage();
    tmpPage.name = TEMP_PAGE_NAME;
    figma.root.appendChild(tmpPage);
    // We must switch to the page before rendering, otherwise
    // Figma won't load fonts correctly.
    figma.currentPage = tmpPage;

    const comments = assetNode.getPluginData(PLUGINDATA_COMMENTS) || undefined;

    try {
        const tmpAssetNode = assetNode.clone();
        tmpPage.appendChild(tmpAssetNode);
        figma.viewport.scrollAndZoomIntoView([tmpAssetNode]);
        updateMissingPluginDataForClonedComponents(tmpAssetNode);

        // Delay is needed as a workaround for the bug in Figma
        // where it starts exporting images without waiting
        // for the page to fully load.
        console.log('Sleeping for 3 seconds');
        await sleep(3000);
        //await exportImagesForAssetNode(tmpAssetNode, page.name); // for debugging without sleep()

        /**/
        const variants = variant ? [variant] : gatherVariantsForAssetNode(assetNode);
        for (let i = 0; i < variants.length; i++) {
            console.log('Exporting asset for [' + variants[i] + '] variant');
            setVariantCode(tmpAssetNode, variants[i]);
            await refreshAllTextNodes(tmpAssetNode, variants[i]);

            // Delay is needed as a workaround for the bug in Figma
            // where layout needs to settle.
            console.log('Sleeping for 2 seconds');
            await sleep(2000);

            // Export asset images under original page name,
            // not a temporary one.
            await exportImagesForAssetNode(tmpAssetNode, page.name);

            // For source variant, also export LocJSON file.
            if (variants[i] === PLUGINDATA_SRC_VARIANT) {
                const data = makeLocJson(tmpAssetNode, page.name, assetNode.id, comments);

                const filePath = getAssetPath(assetNode, page.name);
                filePath.push(PLUGINDATA_SRC_VARIANT);
                const filename = 'localization/' + filePath.join('/') + '.json';
                exportFile(
                    filename,
                    encodeUtf8(JSON.stringify(data, undefined, LOCJSON_INDENT_LENGTH))
                );
            }
        }
        /**/
    } finally {
        figma.currentPage = page;
        console.log('Removing temp page: ' + tmpPage.name);
        tmpPage.remove();
    }
}

/**
 * calculateAssetNodeFingerprint() iterates through relevant
 * properties of the asset tree tree to calculate the fingerprint
 * (integer number).
 * @param assetNode asset node to process.
 */
async function calculateAssetNodeFingerprint(assetNode: SceneNode): Promise<number> {
    let timer1 = prof.start('tree hashing');
    /*
    let fingerprint = hashObj(0, assetNode); // this is extremely slow!
    */

    // step one: make a 0.25x snapshot of the asset to quickly identify
    // visual changes
    const bytes = await assetNode.exportAsync({
        format: 'PNG',
        constraint: {
            type: 'SCALE',
            value: 0.25,
        },
    });
    let fingerprint = crc32arr(bytes);

    // step two: iterate through localizable text nodes and hash
    // their core parameters, and parameters of parent frames
    gatherTextNodesCallback(assetNode, (node: TextNode) => {
        const rendered = renderVariantText(node, PLUGINDATA_SRC_VARIANT);
        fingerprint = hashObj(fingerprint, rendered);
        fingerprint = hashObj(fingerprint, node);
        if (node.parent.type === 'FRAME') {
            fingerprint = hashObj(fingerprint, node.parent);
        }
    });

    // step three: hash asset node comments
    fingerprint = hashStr(fingerprint, assetNode.getPluginData(PLUGINDATA_COMMENTS));

    prof.stopAndReport(timer1);
    return fingerprint;
}

async function parsePendingLocJsonFiles() {
    for (let i = 0; i < filesToParse.length; i++) {
        const message = filesToParse[i];
        await parseLocJsonFile(message.path, message.data);
    }

    filesToParse = [];
    await sleep(500);
    figma.ui.postMessage({
        event: 'parsingCompleted',
    });
}

async function parseLocJsonFile(path: string, rawJson: string) {
    console.log('parseLocJsonFile()', 'path:', path);

    let locJson: any;
    try {
        locJson = JSON.parse(rawJson);
    } catch (e) {
        console.warn('There was a problem parsing LocJSON file ' + path);
        console.warn(e);
        return;
    }
    //console.log('parsed data:', locJson);

    const assetId = locJson.properties ? locJson.properties['x-figma-asset-id'] : undefined;
    if (!assetId) {
        console.warn("Can't read asset ID from the LocJSON file");
        return;
    }

    let assetNode = figma.getNodeById(assetId) as SceneNode;
    if (!assetNode) {
        notify('Node ' + assetId + ' not found');
        return;
    }

    // Split reported LocJSON path into asset path and language name
    const parts = path.match(/(.*)\/(.*?)\.json$/);
    let variant;
    if (parts) {
        path = parts[1];
        variant = parts[2];
    }
    //console.log('path:', path, 'variant:', variant);

    const assetPath = getAssetPath(assetNode).join('/');

    if (assetPath !== path) {
        console.warn(
            'locJSON asset path ' + path + " doesn't match current asset path " + assetPath
        );
        log('File ' + path + ' is obsolete');
        return;
    }

    if (variant === PLUGINDATA_SRC_VARIANT) {
        console.log('Will ignore LocJSON changes for the source variant');
        return;
    }

    if (!locJson.units) {
        console.warn('Bad file format: no units');
        return;
    }

    // Go through the LocJSON units and see if any text nodes
    // need to be updated.

    const dryRun = false; // set to true for debugging purposes

    let assetVariantsUpdated = false;
    for (let i = 0, n = locJson.units.length; i < n; i++) {
        let u = locJson.units[i];
        const id = u.key;
        const text = u.source.join('');

        let node = figma.getNodeById(id) as TextNode;
        if (!node) {
            console.warn('Node ' + id + ' not found');
            continue;
        }

        const oldRendered = renderVariantText(node, variant);
        const oldText = oldRendered.text;

        const srcVariant = getVariantText(node, PLUGINDATA_SRC_VARIANT);
        const isXML = srcVariant && srcVariant.ranges && srcVariant.ranges.length > 0;
        if (!isXML && text.match(/<style0>/)) {
            console.warn('Found "<style0>" text in a variant, but source is not XML?');
        }

        if (oldText !== text) {
            console.log('Node ' + id + ' text has changed.');
            console.log('Old: [' + oldText + '], isXML:', isXML);
            console.log('New: [' + text + ']');
            if (dryRun) {
                console.log('Dry-run mode; text will not be updated');
            } else {
                let styledText: StyledText;
                if (isXML) {
                    try {
                        styledText = parseXml(text);
                    } catch (e) {
                        console.warn('There is a problem with node ' + id + ' text: ' + text);
                        console.warn(e);
                        return;
                    }
                } else {
                    styledText = {
                        text,
                    };
                }

                try {
                    await updateVariant(node, variant, styledText);
                } catch (e) {
                    console.warn(
                        'There was a problem updating variant text from LocJSON file ' + path
                    );
                    console.warn('node:', node, 'variant:', variant, 'styledText:', styledText);
                    console.warn(e);
                    continue;
                }

                assetVariantsUpdated = true;
            }
        }
    }

    if (assetVariantsUpdated) {
        console.log('Some text was updated in the asset; need to export variant files');
        await exportAssetNode(assetNode, variant);
    } else {
        //console.log('No text changes detected in the file');
    }
}

function makeLocJson(
    assetNode: SceneNode,
    pageName?: string,
    assetNodeId?: string,
    comments?: string
): Object {
    const out = {
        properties: {
            comments: [
                'This file was generated by Loctools Figma plugin.',
                'File: ' + figma.root.name,
                'Page: ' + pageName || getPageNode(assetNode).name,
                'Asset: ' + assetNode.name,
            ],
            'x-figma-asset-id': assetNodeId || assetNode.id,
        },
        units: [],
    };

    if (comments !== undefined) {
        out.properties.comments.push(...comments.split(/\n/));
    }

    const filePath = getAssetPath(assetNode, pageName).join('/');

    gatherTextNodesCallback(assetNode, (node: TextNode) => {
        const rendered = renderVariantText(node, PLUGINDATA_SRC_VARIANT);

        const comments = [];
        if (rendered.isXml) {
            comments.push('Text must be formatted according to XML rules');
        }

        let n: SceneNode = node;
        const path = [];
        while (n !== assetNode) {
            const origId = node.getPluginData(PLUGINDATA_ID) || n.id;
            path.unshift(n.name || n.type.toLowerCase() + '#' + origId);
            n = n.parent as SceneNode;
        }

        comments.push('Path: ' + path.join(' > '));

        const origId = node.getPluginData(PLUGINDATA_ID);
        if (origId === '') {
            console.error('No original ID found for node ' + node.id);
            return;
        }

        const url = '{PREVIEW_URL_PREFIX}' + filePath + '/' + PLUGINDATA_SRC_VARIANT + PREVIEW_FILE_EXT + '#' + origId;

        comments.push('Source preview: ' + url);

        const unit = {
            key: origId,
            properties: {
                comments,
            },
            source: wrap(rendered.text, LOCJSON_LINE_LENGTH),
        };
        out.units.push(unit);
    });

    return out;
}

function gatherVariantsForAssetNode(assetNode: SceneNode) {
    const variants = {};
    gatherTextNodesCallback(assetNode, (node: TextNode) => {
        const v = getVariantsObject(node);
        Object.keys(v).forEach((code) => (variants[code] = true));
    });
    return Object.keys(variants).sort();
}

function manageVariantForNode(node: TextNode, action: string, variant: string) {
    const variants = getVariantsObject(node);
    let needSave = false;

    if (action === MANAGE_VARIANT_ACTION_ADD) {
        if (variants[variant] !== undefined) {
            // variant already exists; nothing to do
            return;
        }
        variants[variant] = variants[PLUGINDATA_SRC_VARIANT];
        needSave = true;
        console.log('Added variant ' + variant + ' for node ' + node.id);
    }

    if (action === MANAGE_VARIANT_ACTION_REMOVE) {
        if (variant === PLUGINDATA_SRC_VARIANT) {
            return;
        }
        if (variants[variant] === undefined) {
            // no variant present; nothing to do
            return;
        }
        delete variants[variant];
        needSave = true;
        console.log('Removed variant ' + variant + ' from node ' + node.id);
    }

    if (action === MANAGE_VARIANT_ACTION_REMOVE_OTHER) {
        Object.keys(variants).forEach((code) => {
            if (code !== PLUGINDATA_SRC_VARIANT && code !== variant) {
                delete variants[code];
                needSave = true;
                console.log('Removed variant ' + code + ' from node ' + node.id);
            }
        });
    }
    if (needSave) {
        node.setPluginData(PLUGINDATA_VARIANTS, JSON.stringify(variants));
    }
}

function manageVariantForAsset(assetNode: SceneNode, action: string, variant: string) {
    // scan all text nodes for the given asset, and process them one by one

    const nodes = [];
    gatherTextNodesCallback(assetNode, (node: TextNode) => nodes.push(node));

    nodes.forEach(node => {
        manageVariantForNode(node, action, variant);
    });
}

function manageVariantForPage(pageNode: PageNode, action: string, variant: string) {
    // scan all assets on a current page
    const assetNodes = [];
    gatherAssetNodesCallback(pageNode, (node: SceneNode) => assetNodes.push(node));

    assetNodes.forEach(assetNode => {
        manageVariantForAsset(assetNode, action, variant);
    });
}

function manageVariant(id: string, scope: string, action: string, variant: string) {
    if (action !== MANAGE_VARIANT_ACTION_ADD &&
        action !== MANAGE_VARIANT_ACTION_REMOVE &&
        action !== MANAGE_VARIANT_ACTION_REMOVE_OTHER) {
        notify('Unexpected action: ' + action);
        return;
    }

    if (variant == '') {
        notify('Variant cannot be an empty string');
        return;
    }

    if (action === MANAGE_VARIANT_ACTION_REMOVE && variant === PLUGINDATA_SRC_VARIANT) {
        notify('Source variant cannot be removed');
        return;
    }

    if (scope !== MANAGE_VARIANT_SCOPE_NODE &&
        scope !== MANAGE_VARIANT_SCOPE_ASSET &&
        scope !== MANAGE_VARIANT_SCOPE_PAGE) {
        notify('Unexpected scope: ' + scope);
        return;
    }

    let node = id !== undefined ? figma.getNodeById(id) as SceneNode : undefined;

    if (scope === MANAGE_VARIANT_SCOPE_PAGE) {
        manageVariantForPage(node ? getPageNode(node) : figma.currentPage, action, variant);
        notify("Done.");
        return;
    }

    if (!node) {
        notify('Node ' + id + ' not found');
        return;
    }

    if (scope === MANAGE_VARIANT_SCOPE_ASSET) {
        const assetNode = getAssetNode(node);
        if (!assetNode) {
            notify("Selected node doesn't belong to an exportable asset");
            return;
        }

        manageVariantForAsset(assetNode, action, variant);
        notify("Done.");
        return;
    }

    if (node.type !== 'TEXT') {
        notify('Selected node is not a text node');
        return;
    }

    manageVariantForNode(node, action, variant);
    notify("Done.");
}

function testCustomFn(id: string) {
    let node = figma.getNodeById(id) as SceneNode;
    if (!node) {
        notify('Node ' + id + ' not found');
        return;
    }

    const assetNode = getAssetNode(node);
    if (!assetNode) {
        notify("Selected node doesn't belong to an exportable asset");
        return;
    }

    /** /
    console.log('gatherVariantsForAssetNode() returned ' + gatherVariantsForAssetNode(assetNode));
    /**/

    /** /
    updateMissingPluginDataForClonedComponents(assetNode);
    /**/

    /** /
    const tmpPage = figma.createPage();
    tmpPage.name = TEMP_PAGE_NAME;
    figma.root.appendChild(tmpPage);
    const tmpAssetNode = assetNode.clone();
    tmpPage.appendChild(tmpAssetNode);

    gatherTextNodesCallback(tmpAssetNode, (node: TextNode) => {
        const origId = node.getPluginData(PLUGINDATA_ID);
        console.log('Node:', node.id, ' origId:', origId);
    });
    /**/

    /**/
    calculateAssetNodeFingerprint(assetNode);
    /**/

    /** /
    const data = makeLocJson(assetNode);
    console.log(JSON.stringify(data, undefined, 2));
    /**/
}

/**
 * scanAssets() scans all qualifying assets for changes
 */
async function scanAssets(force: boolean = false) {
    try {
        await scanAssetsInternal(force);
    } finally {
        await sleep(500);
        figma.ui.postMessage({
            event: 'scanningCompleted',
        });
    }
}

async function scanAssetsInternal(force: boolean) {
    const nodes = [];
    const assetPaths = [];

    gatherAssetNodesCallback(figma.root, (node: SceneNode) => {
        // gather all known asset paths
        // (even for assets that are not ready for processing yet)
        assetPaths.push(getAssetPath(node).join('/'));

        if (node.getPluginData(PLUGINDATA_IS_READY) != '1') {
            //console.log('Node ' + node.id + ' is not marked as ready for translation; will skip');
            return;
        }

        if (getVariantCode(node) !== PLUGINDATA_SRC_VARIANT) {
            console.log('Node ' + node.id + ' was switched to a different variant; will skip');
            return;
        }

        nodes.push(node);
    });

    //console.log('assetPaths:', assetPaths);

    const curFingerprint = hashObj(0, assetPaths);
    const oldFingerprint = await figma.clientStorage.getAsync(CLIENTSTORAGE_ASSETS_FINGERPRINT);
    if (force || curFingerprint !== oldFingerprint) {
        figma.ui.postMessage({
            event: 'assetsChange',
            data: assetPaths,
        });
        await figma.clientStorage.setAsync(CLIENTSTORAGE_ASSETS_FINGERPRINT, curFingerprint);
    }

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];

        log(`[${i + 1} / ${nodes.length}] Scanning asset ${node.id} "${node.name}"...`);

        const wasModified = node.getPluginData(PLUGINDATA_WAS_MODIFIED) == '1';
        const fingerprintId = CLIENTSTORAGE_ASSET_FINGERPRINT_PREFIX + node.id;

        const curFingerprint = await calculateAssetNodeFingerprint(node);
        const oldFingerprint = await figma.clientStorage.getAsync(fingerprintId);
        //console.log('curFingerprint:', curFingerprint, 'oldFingerprint:', oldFingerprint);
        if (wasModified || force || curFingerprint !== oldFingerprint) {
            if (force) {
                log('Forced mode, will export the asset');
            } else if (wasModified) {
                log('Asset was manually marked as modified, will export');
            } else {
                log('The fingerprint of node ' + node.id + 'has changed');
            }
            await exportAssetNode(node);
            await figma.clientStorage.setAsync(fingerprintId, curFingerprint);

            if (wasModified) {
                node.setPluginData(PLUGINDATA_WAS_MODIFIED, '');
            }
        }
    }
}
