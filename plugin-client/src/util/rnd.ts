'use strict';

const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const charsLength = chars.length;

function randomStr(length: number): string {
    const out = [];
    for (let i = 0; i < length; i++) {
        out.push(chars.charAt(Math.floor(Math.random() * charsLength)));
    }
    return out.join('');
}

export { randomStr };
