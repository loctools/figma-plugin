#!/bin/bash

. ./env.local

echo "Downloading assets and preview data from the remote server"
rclone sync --verbose "$REMOTE_PATH/assets/" "$LOCAL_PATH/assets/"
rclone sync --verbose "$REMOTE_PATH/preview/" "$LOCAL_PATH/preview/"

echo "Downloading source localization files from the remote server"
rclone sync --verbose --include src.json "$REMOTE_PATH/localization/" "$LOCAL_PATH/localization/"

echo "Updating local repo"
serge pull "$SERGE_CONFIG"

echo "Copying localized files from the local repo to local data folder"
rsync --verbose --recursive --exclude="src.json" "$GIT_LOCAL/localization/" "$LOCAL_PATH/localization/"

echo "Scanning and deleting orphaned localization files in local data folder"

cd "$LOCAL_PATH"

FILES=`find localization`

IFS='' read -r -d '' PERL_PROGRAM <<"EOF"
my $f = $ENV{FILE};
my $src = $f;
$src =~ s|/[\w\-]+\.json$|/src.json|;
if ($f ne $src && !-f $src) {
  print "Deleting $f\n";
  unlink $f;
}
EOF

for f in $FILES
do
  export FILE="$f"
  echo $PERL_PROGRAM | perl
done

echo "Removing empty directories in the local data folder"
find "$LOCAL_PATH" -type d -empty -delete -print

echo "Copying source localization files from the local data folder into the local Git repo"
rsync --verbose --delete --recursive "$LOCAL_PATH/localization/" "$GIT_LOCAL/localization/"
cd "$GIT_LOCAL" && git status

echo "Pushing changes to the repo"
serge push "$SERGE_CONFIG"

echo "Uploading localized files to the remote server"
rclone sync --verbose --exclude src.json "$LOCAL_PATH/localization/" "$REMOTE_PATH/localization/"
