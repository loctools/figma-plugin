'use strict';

const TEMP_PAGE_NAME = '__temp__';

/**
 * isAssetNode checks if the node can be qualified as an asset
 * (visible / exportable / localizable) node. Initially the idea was to
 * allow various types of nodes (FRAME, GROUP or COMPONENT)
 * as qualifying ones, but since we want to temporarily disable shadows
 * when generating preview images, and only FRAME nodes allow clipping,
 * it looks like a limitation will be to always use a wrapper FRAME
 * node for each asset. FRAME nodes also show their names on top,
 * so it's an added visibility bonus.
 * @param node SceneNode to test.
 */
function isAssetNode(node: SceneNode): boolean {
    return (
        node &&
        node.visible &&
        node.type === 'FRAME' /*|| node.type === 'GROUP' || node.type === 'COMPONENT'*/ &&
        node.parent &&
        node.parent.type === 'PAGE'
    );
}

/**
 * compareXYCoords() is a comparison function that helps sort
 * children nodes according to their coordinates within parent
 * (top to bottom, left to right). If two objects share the same
 * X/Y coordinates, comparison is done by node IDs to stabilize
 * the output.
 * @param a First scene node
 * @param b Second scene node
 */
function compareXYCoords(a: SceneNode, b: SceneNode): number {
    if (a.y < b.y) {
        return -1;
    }
    if (a.y > b.y) {
        return 1;
    }
    if (a.x < b.x) {
        return -1;
    }
    if (a.x > b.x) {
        return 1;
    }
    // fall back to sorting by ID
    return a.id.localeCompare(b.id, 'en');
}

function gatherTextNodesCallback(node: SceneNode, callback: (TextNode) => void) {
    if ((node as SceneNodeMixin).visible === false) {
        return;
    }

    if (node.type === 'TEXT') {
        callback(node);
        return;
    }

    if (!(node as ChildrenMixin).children) {
        return;
    }

    const ch = [...(node as ChildrenMixin).children];
    ch.sort(compareXYCoords);

    const len = ch.length;
    for (let i = 0; i < len; i++) {
        gatherTextNodesCallback(ch[i] as SceneNode, callback);
    }
}

function compareNames(a: SceneNode | PageNode, b: SceneNode | PageNode): number {
    const n = a.name.localeCompare(b.name, 'en');
    if (n !== 0) {
        return n;
    }
    // fall back to sorting by ID
    return a.id.localeCompare(b.id, 'en');
}

function gatherAssetNodesCallback(
    node: DocumentNode | PageNode,
    callback: (SceneNode) => void
) {
    let ch = [...node.children];
    ch.sort(compareNames);

    const len = ch.length;
    for (let i = 0; i < len; i++) {
        if (node.type === 'DOCUMENT') {
            gatherAssetNodesCallback(ch[i] as PageNode, callback);
            continue;
        }

        if (node.type === 'PAGE') {
            if (node.name === TEMP_PAGE_NAME) {
                continue;
            }
            if (isAssetNode(ch[i] as SceneNode)) {
                callback(ch[i]);
            }
        }
    }
}

export { TEMP_PAGE_NAME, isAssetNode, gatherTextNodesCallback, gatherAssetNodesCallback };
