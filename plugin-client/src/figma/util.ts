'use strict';

function gotoNode(id: string): SceneNode | undefined {
    let node = figma.getNodeById(id) as SceneNode;
    if (!node) {
        console.warn('node [' + id + '] not found');
        return;
    }

    // find the page node
    let pageNode: any = node;
    while (pageNode !== null && pageNode.type !== 'PAGE') {
        pageNode = pageNode.parent;
    }
    // sanity check
    if (pageNode === null) {
        console.warn('pageNode is null');
        return;
    }
    // switch to the page the target node belongs
    figma.currentPage = pageNode;
    // select the target node
    figma.currentPage.selection = [node];
    return node;
}

export { gotoNode };
