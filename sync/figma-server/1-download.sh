#!/bin/sh

. ./env.local

echo "Downloading localized files from the remote server"
rclone sync \
    --verbose \
    --exclude src.json \
    $REMOTE_PATH/localization/ \
    $LOCAL_PATH/localization/