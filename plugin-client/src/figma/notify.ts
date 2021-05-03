'use strict';

let notificationHandler: NotificationHandler;

function notify(message: string) {
    if (notificationHandler) {
        notificationHandler.cancel();
    }
    console.log('%c notify ', 'background: #000; color: #fff; border-radius: 3px;', message);
    notificationHandler = figma.notify(message);
}

export { notify };
