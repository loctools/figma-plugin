'use strict';

function wrap(s: string, length: number): string[] {
    if (length <= 0) {
        return [s];
    }

    // Wrap by '\n' explicitly.
    const m = s.match(/^(.*?(?:\\n|\n))(.+)$/s);
    if (m) {
        const a = wrap(m[1], length);
        const b = wrap(m[2], length);
        return [...a, ...b];
    }

    if (s.length <= length) {
        return [s];
    }

    // Split by whitespace.
    const a = s.split(/(\s+)/);

    const lines = [];
    let accum = '';
    while (a.length > 0) {
        // Take the next chunk and append the
        // following whitespace chunk to it, if any.
        let chunk = a.shift();
        if (a.length > 0 && a[0].match(/^\s*$/)) {
            chunk += a.shift();
        }

        if (accum.length + chunk.length > length) {
            if (accum !== '') {
                lines.push(accum);
            }

            while (chunk.length >= length) {
                lines.push(chunk.substring(0, length));
                chunk = chunk.substring(length);
            }

            accum = chunk;
        } else {
            accum += chunk;
        }
    }
    if (accum !== '') {
        lines.push(accum);
    }

    return lines;
}

export { wrap };
