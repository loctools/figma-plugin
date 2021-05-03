'use strict';

import { encodeUtf8 } from './utf8';

let crcTable: number[];

function makeCRCTable() {
    crcTable = new Array(256);
    let c: number;
    for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        crcTable[n] = c;
    }
}

function initCrc32(): number {
    if (crcTable === undefined) {
        makeCRCTable();
    }

    return 0 ^ -1;
}

function updateCrc32(crc: number, arr: Uint8Array): number {
    for (let i = 0; i < arr.length; i++) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ arr[i]) & 0xff];
    }
    return crc;
}

function finishCrc32(crc: number): number {
    return (crc ^ -1) >>> 0;
}

function crc32arr(arr: Uint8Array): number {
    return finishCrc32(updateCrc32(initCrc32(), arr));
}

function crc32str(str: string): number {
    return crc32arr(encodeUtf8(str));
}

export { initCrc32, updateCrc32, finishCrc32, crc32arr, crc32str };
