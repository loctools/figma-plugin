'use strict';

import { crc32str } from '../util/crc32';
import { xmlEncode, xmlDecode } from '../util/xml';

interface StyleRange {
    start: number;
    end: number;
    styleIdx: number;
}

interface StyledText {
    text: string;
    //crc?: string;
    ranges?: StyleRange[];
    styles?: Object[];
}

function getStyledText(node: TextNode): StyledText | undefined {
    const s = node.characters;
    const len = s.length;

    // If string is empty, return early.
    if (len === 0) {
        return {
            text: '',
        };
    }

    const mixedProps = {};

    function checkIfMixedProp(name: string, fn: Function) {
        if (fn.call(node, 0, len) === figma.mixed) {
            mixedProps[name] = true;
        }
    }

    checkIfMixedProp('fillStyleId', node.getRangeFillStyleId);
    checkIfMixedProp('fills', node.getRangeFills);
    checkIfMixedProp('fontName', node.getRangeFontName);
    checkIfMixedProp('fontSize', node.getRangeFontSize);
    checkIfMixedProp('letterSpacing', node.getRangeLetterSpacing);
    checkIfMixedProp('lineHeight', node.getRangeLineHeight);
    checkIfMixedProp('textCase', node.getRangeTextCase);
    checkIfMixedProp('textDecoration', node.getRangeTextDecoration);
    checkIfMixedProp('textStyleId', node.getRangeTextStyleId);

    const keys = Object.keys(mixedProps);
    console.log('mixedProps:', keys);

    if (keys.length === 0) {
        // This is a plain text, return early.
        return {
            text: s,
        };
    }

    function getMixedProp(name: string, fn: Function, i: number, out: Object) {
        if (!mixedProps[name]) {
            return;
        }
        out[name] = fn.call(node, i, i + 1);
    }

    function getAllMixedProps(i: number): Object {
        let props = {};
        getMixedProp('fillStyleId', node.getRangeFillStyleId, i, props);
        getMixedProp('fills', node.getRangeFills, i, props);
        getMixedProp('fontName', node.getRangeFontName, i, props);
        getMixedProp('fontSize', node.getRangeFontSize, i, props);
        getMixedProp('letterSpacing', node.getRangeLetterSpacing, i, props);
        getMixedProp('lineHeight', node.getRangeLineHeight, i, props);
        getMixedProp('textCase', node.getRangeTextCase, i, props);
        getMixedProp('textDecoration', node.getRangeTextDecoration, i, props);
        getMixedProp('textStyleId', node.getRangeTextStyleId, i, props);
        return props;
    }

    let uniqueProps = {};
    let uniquePropCrcByIdx = [];
    let uniquePropIdxByCrc = {};

    for (let i = 0; i < len; i++) {
        let props = getAllMixedProps(i);
        let propStr = JSON.stringify(props);
        let crc = crc32str(propStr);

        if (uniqueProps[crc] === undefined) {
            uniqueProps[crc] = props;
            uniquePropCrcByIdx.push(crc);
            uniquePropIdxByCrc[crc] = uniquePropCrcByIdx.length - 1;
        }
        //console.log('i:', i, 'propStr:', propStr, 'crc:', crc);
    }

    /*
    console.log('uniquePropCrcByIdx:', uniquePropCrcByIdx);
    console.log('uniquePropIdxByCrc:', uniquePropIdxByCrc);

    for (let i = 0; i < uniquePropCrcByIdx.length; i++) {
        console.log(`uniqueProps[${i}]`, 'crc:', uniquePropCrcByIdx[i], 'prop:', uniqueProps[uniquePropCrcByIdx[i]]);
    }
    */

    let prevCrc = -1;
    let startIdx = -1;
    let ranges: StyleRange[] = [];
    for (let i = 0; i < len; i++) {
        let props = getAllMixedProps(i);
        let propStr = JSON.stringify(props);
        let crc = crc32str(propStr);
        //console.log('[pass 2] i:', i, 'propStr:', propStr, 'crc:', crc);

        if (crc !== prevCrc) {
            if (startIdx >= 0) {
                ranges.push({
                    start: startIdx,
                    end: i,
                    styleIdx: uniquePropIdxByCrc[prevCrc],
                });
            }
            prevCrc = crc;
            startIdx = i;
        }
    }
    if (startIdx >= 0 && startIdx < len - 1) {
        ranges.push({
            start: startIdx,
            end: len,
            styleIdx: uniquePropIdxByCrc[prevCrc],
        });
    }

    const styles = [];
    for (let i in uniquePropCrcByIdx) {
        styles.push(uniqueProps[uniquePropCrcByIdx[i]]);
    }

    return {
        text: s,
        ranges,
        styles,
    };
}

/**
 * makeXml() builds an XML-like string
 * from a StyledText object.
 * @param styled StyledText input object
 */
function makeXml(styled: StyledText): string {
    if (!styled.ranges) {
        return '';
    }

    const out = [];
    styled.ranges.forEach((range) => {
        var ss = styled.text.substring(range.start, range.end);
        const tag = `style${range.styleIdx}`;
        ss = xmlEncode(ss);
        out.push(`<${tag}>${ss}</${tag}>`);
        //console.log('start:', range.start, 'end:', range.end, 'style:', range.styleIdx);
    });
    return out.join('');
}

/**
 * parseXml() parses an input string marked up
 * with <styleN>...</styleN> XML-like tags.
 * Example: "<style0>foo</style0><style1>bar</style1>".
 * In case of incorrect format, it will throw an error.
 * @param str Input string
 */
function parseXml(str: string): StyledText {
    let out: string[] = [];
    let ranges: StyleRange[] = [];
    let insideTag = false;
    let currentStyleIdx: number | undefined;
    let startPos = 0;

    const a = str.split(/([<>])/);

    // if it's a plain text, return early
    if (a.length === 1) {
        return {
            text: xmlDecode(str),
        };
    }

    for (let i in a) {
        let s = a[i];
        if (s === '') {
            continue;
        }

        if (s === '<') {
            insideTag = true;
            continue;
        }

        if (s === '>') {
            insideTag = false;
            continue;
        }

        if (insideTag) {
            let m = s.match(/^style(\d+)$/);
            if (m !== null) {
                let idx = +m[1]; // cast to a number
                if (currentStyleIdx !== undefined) {
                    throw 'Overlapping styles not allowed. currentStyleIdx: ' + currentStyleIdx;
                }
                currentStyleIdx = idx;
                continue;
            }

            m = s.match(/^\/style(\d+)$/);
            if (m !== null) {
                let idx = +m[1]; // cast to a number
                if (currentStyleIdx !== idx) {
                    throw (
                        "End style tag doesn't match the opening one. currentStyleIdx: " +
                        currentStyleIdx +
                        ', closing idx: ' +
                        idx
                    );
                }
                currentStyleIdx = undefined;
                continue;
            }

            if (currentStyleIdx === undefined) {
                throw 'Text outside a style tag: [' + s + ']';
            }
        }

        if (!insideTag) {
            s = xmlDecode(s);
            out.push(s);
            ranges.push({
                start: startPos,
                end: startPos + s.length,
                styleIdx: currentStyleIdx,
            });

            startPos += s.length;
        }
    }

    if (currentStyleIdx !== undefined) {
        throw 'Missing end style tag. currentStyleIdx: ' + currentStyleIdx;
    }

    return {
        text: out.join(''),
        ranges,
    };
}

async function preloadFonts(node: TextNode, text: StyledText) {
    console.log('preloadFonts()', 'text:', text);

    // If it is a plain-text node, or if the node
    // doesn't have font defined in its styles,
    // then preload the font for the first character only
    if (!text.styles || !text.styles[0] || !text.styles[0]['fontName']) {
        const f = node.getRangeFontName(0, 1) as FontName;
        //console.log('Preloading first character font for node ' + node.id + ':', f);
        await figma.loadFontAsync(f);
    }

    if (!text.styles) {
        return;
    }

    for (let i in text.styles) {
        let style = text.styles[i];

        if (style['fontName'] !== undefined) {
            const f = style['fontName'] as FontName;
            console.log('Preloading font for node ' + node.id + ':', f);
            await figma.loadFontAsync(f);
        }
    }
}

async function applyTextStyles(node: TextNode, text: StyledText) {
    console.log('applyTextStyles()', 'text:', text);

    const len = node.characters.length;

    for (let i in text.ranges) {
        //console.log('i:', i);
        let range = text.ranges[i];
        let style = text.styles[range.styleIdx || 0]; // default to style 0
        if (range.start >= len) {
            //console.log('range starts past the string length, stopping');
            break;
        }

        let adjustedEnd = range.end;
        if (range.end > len) {
            adjustedEnd = len;
            //console.log('range ends past the string, trimming');
        } else {
            //console.log('range is ok');
        }

        if (style['fontName'] !== undefined) {
            const f = style['fontName'] as FontName;
            //console.log('Preloading font:', f);
            await figma.loadFontAsync(f);
        }

        function setStyle(name: string, fn: Function) {
            if (!style[name]) {
                return;
            }
            //console.log('setStyle()', 'name:', name);
            try {
                fn.call(node, range.start, adjustedEnd, style[name]);
            } catch (e) {
                console.error('setStyle() failed for node', node.id, 'at function', name);
                console.error(e);
                console.error();
                console.error(
                    'node.characters:',
                    node.characters,
                    'text:',
                    text,
                    'len:',
                    len,
                    'range.start:',
                    range.start,
                    'adjustedEnd:',
                    adjustedEnd,
                    'style[name]:',
                    style[name]
                );
                throw 'applyTextStyles() failed for node ' + node.id;
            }
        }

        setStyle('fillStyleId', node.setRangeFillStyleId);
        setStyle('fills', node.setRangeFills);
        setStyle('fontName', node.setRangeFontName);
        setStyle('fontSize', node.setRangeFontSize);
        setStyle('letterSpacing', node.setRangeLetterSpacing);
        setStyle('lineHeight', node.setRangeLineHeight);
        setStyle('textCase', node.setRangeTextCase);
        setStyle('textDecoration', node.setRangeTextDecoration);
        setStyle('textStyleId', node.setRangeTextStyleId);
    }
}

export { StyleRange, StyledText, getStyledText, makeXml, parseXml, preloadFonts, applyTextStyles };
