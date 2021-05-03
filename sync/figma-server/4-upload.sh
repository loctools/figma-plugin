#!/bin/sh

. ./env.local

echo "Uploading assets and preview data to the remote server"
rclone sync --verbose $LOCAL_PATH/assets/ $REMOTE_PATH/assets/
rclone sync --verbose $LOCAL_PATH/preview/ $REMOTE_PATH/preview/

echo "Uploading source localization files to the remote server"
rclone sync --verbose --include src.json $LOCAL_PATH/localization/ $REMOTE_PATH/localization/
