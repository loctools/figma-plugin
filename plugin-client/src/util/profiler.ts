'use strict';

interface Timer {
    id: string;
    start: number;
    end?: number;
}

let timers = {};
let counters = {};

let idx = 0;

function formatTime(ms: number): string {
    const parts = [];
    if (ms >= 1000) {
        parts.push(Math.floor(ms / 1000) + 's');
        ms = ms % 1000;
    }
    parts.push(ms + 'ms');
    return parts.join(' ');
}

function start(id: string): number {
    idx++;
    timers[idx] = {
        id,
        start: new Date().getTime()
    };
    return idx;
}

function stop(idx: number): Timer | undefined {
    const now = new Date().getTime();
    const timer = timers[idx];
    if (!timer) {
        console.error('timeStop: timer ' + idx + ' not found');
        return;
    }
    delete timers[idx];
    timer.end = now;
    return timer;
}

function stopAndReport(idx: number) {
    const timer = stop(idx);
    if (!timer) {
        return;
    }
    console.log(timer.id + ' took ' + formatTime(timer.end - timer.start));
}

function stopAndAppend(idx: number) {
    const timer = stop(idx);
    if (!timer) {
        return;
    }
    if (counters[timer.id] === undefined) {
        counters[timer.id] = 0;
    }
    counters[timer.id] += timer.end - timer.start;
}

function report() {
    const keys = Object.keys(counters).sort();
    if (keys.length === 0) {
        console.log('Profiler report is empty');
        return;
    }

    console.log('Profiler report:');
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        console.log(' - ' + key + ' took ' + formatTime(counters[key]));
    }
}

function reset() {
    counters = {};
}

export default { start, stop, stopAndReport, stopAndAppend, report, reset };
