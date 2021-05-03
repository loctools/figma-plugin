This folder contains example synchronization scripts that allow to synchronize data between the computer that runs Figma, a cloud storage like Amazon S3, and a Git repository where localization can happen.

While it is possible to set up synchronization between the Figma computer and Git directly, an approach where files are exchanged via a cloud storage is safer.

`figma-server/sync-loop.sh` script is meant to be run on a Figma computer. See `figma-server/env.local.example` for configuration settings.

`l10n-server/sync-once.sh` script is meant to be run on a localization server as a part of the localization cycle. See `l10n-server/env.local.example` for configuration settings.
