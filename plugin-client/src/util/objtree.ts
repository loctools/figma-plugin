'use strict';

const memoizedKeys = {};

function hashStr(hash: number, s: string): number {
    /**/
    if (s.length == 0) return hash;
    for (let i = 0, l = s.length; i < l; i++) {
        const char = s.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash |= 0; // convert to 32bit integer
    }
    return hash;
}

function hashObj(hash: number, obj: any): number {
    if (obj === null || obj === undefined) {
        return hash;
    }

    const t = typeof obj;

    if (t === 'number' || t === 'boolean') {
        return hashStr(hash, '' + obj);
    }

    if (t === 'string') {
        //return updateCrc32(crc, encodeUtf8(obj));
        return hashStr(hash, obj);
    }

    if (t !== 'object') {
        //return updateCrc32(crc, encodeUtf8(obj.toString()));
        return hashStr(hash, obj.toString());
    }

    if (Array.isArray(obj)) {
        for (let i in obj) {
            hash = hashStr(hash, '' + i);
            hash = hashObj(hash, obj[i]);
        }
        return hash;
    }

    let keys;
    const type = obj['type'];
    if (type === undefined) {
        keys = Object.keys(obj).sort();
    } else {
        keys = memoizedKeys[type];
        if (keys === undefined) {
            const k = {};
            Object.keys(Object.getPrototypeOf(obj)).forEach((key) => (k[key] = true));
            Object.keys(obj).forEach((key) => (k[key] = true));
            memoizedKeys[type] = keys = Object.keys(k).sort();
        }
    }

    for (let i in keys) {
        const prop = keys[i];
        if (prop === 'parent' || prop === '__proto__') {
            continue;
        }
        hash = hashStr(hash, prop);
        try {
            hash = hashObj(hash, obj[prop]);
        } catch (e) {
            console.warn('Failed to retrieve prop "' + prop + '" of object');
        }
    }
    return hash;
}

export { hashObj, hashStr };
